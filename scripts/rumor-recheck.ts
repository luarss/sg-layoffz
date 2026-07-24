// Rumor-resolution lifecycle: re-check stale `rumored` rows in data/layoffs.csv and
// decide whether each one has resolved. For every stale rumor we pull fresh follow-up
// coverage (Google News RSS + optionally Exa, via the shared ./search helpers) and ask
// the LLM (same provider chain as llm-triage, via ./llm-provider) to classify it into:
//
//   confirmed      — the company / a credible outlet confirmed the cuts happened
//   denied         — the company or credible reporting denied / walked back the rumor
//   expired        — no follow-up coverage; the rumor went nowhere (only for stale ones)
//   still-rumored  — coverage continues but nothing confirms it yet
//
// Decisions are written to data/rumor-recheck-results.csv. This script NEVER mutates
// layoffs.csv — apply-rumor-results.ts does that as a separate, reviewable step.
//
// Usage:
//   tsx scripts/rumor-recheck.ts            # rumors older than 30 days
//   tsx scripts/rumor-recheck.ts --days 14  # rumors older than 14 days
//   tsx scripts/rumor-recheck.ts --all      # every rumor, regardless of age
//
// Env vars: same LLM keys as llm-triage (see ./llm-provider), plus optional EXA_API_KEY.

import type OpenAI from 'openai';
import { readCsv, writeCsvRaw } from '../src/lib/csv';
import { LayoffEntry } from '../src/lib/types';
import { ProviderConfig, getProviderChain } from './llm-provider';
import { searchGoogleNews, searchExa, SearchHit } from './search';

export const RECHECK_STATUSES = ['confirmed', 'denied', 'expired', 'still-rumored'] as const;
export type RecheckStatus = (typeof RECHECK_STATUSES)[number];

export interface RecheckVerdict {
  new_status: RecheckStatus;
  evidence_url: string;
  headcount: number | null;
  note: string;
}

export interface RecheckResultRow {
  company: string;
  date_announced: string;
  current_status: string;
  new_status: RecheckStatus;
  evidence_url: string;
  evidence_note: string;
  checked_at: string;
}

export const RESULT_HEADERS: (keyof RecheckResultRow)[] = [
  'company',
  'date_announced',
  'current_status',
  'new_status',
  'evidence_url',
  'evidence_note',
  'checked_at',
];

const DEFAULT_DAYS = 30;

interface CliOptions {
  days: number;
  all: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { days: DEFAULT_DAYS, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--days') {
      const n = parseInt(argv[++i] || '', 10);
      if (!Number.isNaN(n)) opts.days = n;
    } else if (arg.startsWith('--days=')) {
      const n = parseInt(arg.slice('--days='.length), 10);
      if (!Number.isNaN(n)) opts.days = n;
    }
  }
  return opts;
}

// Whole days between a row's announcement date and `now` (negative if in the future).
export function ageInDays(dateAnnounced: string, now: Date): number {
  const d = new Date(dateAnnounced);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

// Select the rumored rows this run should re-check. With --all, every rumor; otherwise
// only those at least `days` old (rumors are meant to resolve within the window).
export function selectStaleRumors(
  rows: LayoffEntry[],
  opts: CliOptions,
  now: Date
): LayoffEntry[] {
  return rows.filter((r) => {
    if (r.status !== 'rumored') return false;
    if (opts.all) return true;
    return ageInDays(r.date_announced, now) >= opts.days;
  });
}

const SYSTEM_PROMPT = `You are a fact-checker for a Singapore layoff tracking database. A layoff event was previously recorded as RUMORED (planned / anticipated / reported-but-unconfirmed). Using the follow-up news evidence provided, decide what has happened to that rumor since.

Classify into exactly one status:
- "confirmed": the company itself, a government/ministry filing, or credible follow-up reporting confirms the job cuts actually happened or are actively underway. Capture the URL that confirms it.
- "denied": the company or credible reporting denied, retracted, or walked back the rumor (e.g. "no layoffs planned", "reports are inaccurate").
- "expired": there is NO meaningful follow-up coverage and the rumor appears to have gone nowhere. Use this for old rumors that were never substantiated.
- "still-rumored": follow-up coverage exists but still only reports the cuts as planned/anticipated/unconfirmed.

Be conservative: only choose "confirmed" or "denied" when the evidence is clear. When in doubt between confirmed and still-rumored, choose still-rumored.

Return ONLY a valid JSON object (no markdown):
{
  "new_status": "confirmed" | "denied" | "expired" | "still-rumored",
  "evidence_url": "<the single most relevant follow-up URL, or empty string if none>",
  "headcount": <integer number of Singapore jobs confirmed cut, or null>,
  "note": "1-2 sentence justification citing the evidence"
}`;

function buildUserPrompt(rumor: LayoffEntry, hits: SearchHit[]): string {
  const lines: string[] = [
    `Rumored event:`,
    `  Company: ${rumor.company}`,
    `  Date first recorded: ${rumor.date_announced}`,
    `  Existing note: ${rumor.notes || '(none)'}`,
    `  Original source: ${rumor.source_link || '(none)'}`,
    ``,
    `Follow-up evidence (${hits.length} result(s)):`,
  ];
  if (hits.length === 0) {
    lines.push('  (no follow-up coverage found)');
  } else {
    hits.forEach((h, i) => {
      lines.push(
        `  [${i + 1}] ${h.title}`,
        `      url: ${h.url}`,
        `      date: ${h.publishedDate || 'unknown'}`,
        `      snippet: ${h.snippet.slice(0, 300)}`
      );
    });
  }
  return lines.join('\n');
}

// Validate/coerce a raw LLM response into a RecheckVerdict. Returns null when the JSON
// is unparseable or the status is missing/out-of-enum, so callers can fall through to
// the next provider instead of emitting a bogus verdict.
export function parseRecheckVerdict(raw: string): RecheckVerdict | null {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || !(RECHECK_STATUSES as readonly string[]).includes(json.new_status)) {
    return null;
  }
  return {
    new_status: json.new_status as RecheckStatus,
    evidence_url: typeof json.evidence_url === 'string' ? json.evidence_url : '',
    headcount: typeof json.headcount === 'number' ? json.headcount : null,
    note: typeof json.note === 'string' ? json.note : '',
  };
}

// Single LLM call against one client. Accepts an OpenAI-compatible client so tests can
// inject a mock without touching the network. Returns null on API error or bad JSON.
export async function classifyRumor(
  client: Pick<OpenAI, 'chat'>,
  model: string,
  rumor: LayoffEntry,
  hits: SearchHit[]
): Promise<RecheckVerdict | null> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(rumor, hits) },
    ],
    temperature: 0,
    max_tokens: 512,
    response_format: { type: 'json_object' },
  });
  const rawText = response.choices[0]?.message?.content || '{}';
  return parseRecheckVerdict(rawText);
}

// Try each provider in order until one returns a valid verdict.
async function classifyWithChain(
  chain: ProviderConfig[],
  rumor: LayoffEntry,
  hits: SearchHit[]
): Promise<RecheckVerdict | null> {
  for (const provider of chain) {
    try {
      const verdict = await classifyRumor(provider.client, provider.model, rumor, hits);
      if (verdict) return verdict;
    } catch (err) {
      process.stdout.write(` [${provider.name} failed, trying next]`);
    }
  }
  return null;
}

// Map a rumor + verdict into the flat result-CSV row.
export function buildResultRow(
  rumor: LayoffEntry,
  verdict: RecheckVerdict,
  checkedAt: string
): RecheckResultRow {
  const headcountNote =
    verdict.new_status === 'confirmed' && verdict.headcount != null
      ? ` (~${verdict.headcount} Singapore jobs)`
      : '';
  return {
    company: rumor.company,
    date_announced: rumor.date_announced,
    current_status: rumor.status,
    new_status: verdict.new_status,
    evidence_url: verdict.evidence_url || '',
    evidence_note: `${verdict.note}${headcountNote}`.trim(),
    checked_at: checkedAt,
  };
}

// Gather follow-up coverage for one rumor, reusing the shared scrape helpers.
async function gatherEvidence(rumor: LayoffEntry): Promise<SearchHit[]> {
  const query = `${rumor.company} Singapore layoffs OR retrenchment OR job cuts`;
  const hits: SearchHit[] = [];

  const gnews = await searchGoogleNews(query);
  hits.push(...gnews);

  const exaKey = process.env.EXA_API_KEY;
  if (exaKey) {
    try {
      const exa = await searchExa(exaKey, `${rumor.company} Singapore layoffs update`, {
        numResults: 5,
        maxCharacters: 1200,
      });
      hits.push(...exa);
    } catch (err) {
      console.error(`    Exa search failed: ${(err as Error).message}`);
    }
  }

  // Dedup by URL, keep the first occurrence.
  const seen = new Set<string>();
  return hits.filter((h) => {
    if (!h.url || seen.has(h.url)) return false;
    seen.add(h.url);
    return true;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const checkedAt = now.toISOString().slice(0, 10);

  const rows = readCsv('layoffs.csv') as LayoffEntry[];
  const stale = selectStaleRumors(rows, opts, now);

  console.log(
    `Rumor recheck: ${stale.length} rumor(s) to check ` +
      (opts.all ? '(--all)' : `(older than ${opts.days} days)`)
  );
  if (stale.length === 0) {
    writeCsvRaw('rumor-recheck-results.csv', [], RESULT_HEADERS as string[]);
    return;
  }

  const chain = getProviderChain();
  console.log(`Provider chain: ${chain.map((p) => `${p.name}(${p.model})`).join(' → ')}\n`);

  const results: RecheckResultRow[] = [];
  for (let i = 0; i < stale.length; i++) {
    const rumor = stale[i];
    process.stdout.write(`  [${i + 1}/${stale.length}] ${rumor.company.slice(0, 45).padEnd(45)} `);

    const hits = await gatherEvidence(rumor);
    const verdict = await classifyWithChain(chain, rumor, hits);

    if (!verdict) {
      console.log('→ (no verdict; left as still-rumored)');
      results.push(
        buildResultRow(
          rumor,
          { new_status: 'still-rumored', evidence_url: '', headcount: null, note: 'LLM classification failed; no change.' },
          checkedAt
        )
      );
      continue;
    }

    console.log(`→ ${verdict.new_status}`);
    results.push(buildResultRow(rumor, verdict, checkedAt));

    // Gentle pacing between rows to be kind to the RSS/search endpoints.
    await new Promise((r) => setTimeout(r, 500));
  }

  writeCsvRaw(
    'rumor-recheck-results.csv',
    results as unknown as Record<string, unknown>[],
    RESULT_HEADERS as string[]
  );

  const tally = (s: RecheckStatus) => results.filter((r) => r.new_status === s).length;
  console.log(`\nWrote data/rumor-recheck-results.csv (${results.length} rows)`);
  console.log(
    `  confirmed=${tally('confirmed')} denied=${tally('denied')} ` +
      `expired=${tally('expired')} still-rumored=${tally('still-rumored')}`
  );
  console.log('Run `tsx scripts/apply-rumor-results.ts` to patch layoffs.csv.');
}

// Only run the pipeline when invoked directly, so the pure helpers above can be
// imported by tests without triggering a live run.
if (process.argv[1] && process.argv[1].endsWith('rumor-recheck.ts')) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
