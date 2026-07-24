// LLM-powered triage for review-queue.csv entries.
// Reads data/review-queue.csv, classifies each entry using an LLM with automatic
// provider fallback (DeepSeek → MiMo → OpenRouter), and routes results to:
//   - data/layoffs.csv      (confirmed + rumored)
//   - data/rejected.csv     (rejected)
//   - data/review-queue.csv (needs_review — kept for manual triage)
// Writes data/llm-triage-summary.json with full run stats.
//
// Provider fallback order: DeepSeek → MiMo (Xiaomi) → OpenRouter
// Providers are included automatically when their keys are present.
// A provider is skipped (and the next tried) when it returns an API error.
// The provider chain wiring lives in ./llm-provider (shared with rumor-recheck).

import fs from 'node:fs';
import { readCsv, appendCsv, writeCsv } from '../src/lib/csv';
import { LayoffEntry } from '../src/lib/types';
import { LLMVerdict, coerceVerdict } from '../src/lib/verdict';
import { normalizeCompany } from './normalize';
import { ProviderConfig, getProviderChain } from './llm-provider';

// Derive a kebab-case event_id from company + event month, used when the model does
// not propose one (or proposes a blank).
function eventIdFor(company: string, date: string): string {
  const slug = normalizeCompany(company || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const month = (date || '').slice(0, 7);
  return `${slug || 'event'}-${month || 'unknown'}`;
}

interface SummaryRow {
  original_company: string;
  llm_company: string;
  source_link: string;
  verdict: string;
  confidence: string;
  provider: string;
  notes: string;
  rejection_reason?: string;
}

const SYSTEM_PROMPT = `You are an expert analyst for a Singapore layoff tracking database. Evaluate news articles about potential Singapore layoff events and classify each one.

## Classification Rules

**CONFIRMED** — all must be true:
- Officially announced or credibly reported job cuts/retrenchment
- Specific named company with Singapore operations
- Already happened or actively underway (not a future plan)

**RUMORED** — same as confirmed but:
- Planned, anticipated, or reported as likely ("plans to cut", "expected to retrench", "may lay off")

**Closures count as layoff events.** A Singapore business, store, outlet, or branch
closure that implies job losses IS a layoff event — even when the headcount is unstated
and even when it is a single outlet of a continuing chain. Classify it CONFIRMED if it has
already closed or is actively closing, RUMORED if it is an announced or future closure. Do
NOT reject a Singapore closure as "not a layoff" or as having "no Singapore nexus".

**REJECTED** — reject if ANY applies:
- Commentary, opinion, analysis, or market overview about layoffs in general
- Labour market statistics (MOM data, employment surveys, percentage reports)
- Government or parliamentary policy debate (MAS, MOM proposals, union discussions)
- Job posting or hiring announcement
- No clear Singapore nexus (foreign company, foreign office only)
- Personal anecdote or first-person story ("I got laid off…")
- Aggregator article covering many companies (not a single specific event)
- Legal case, court ruling, or severance policy debate
- Duplicate of an already well-known event

**NEEDS_REVIEW** — genuinely ambiguous; you cannot make a confident determination.

## Evaluation Dimensions (assess internally)
1. singapore_nexus — does this involve a Singapore entity or Singapore office of a multinational?
2. layoff_authenticity — is this a real layoff announcement (not commentary or statistics)?
3. company_identifiable — is a specific company clearly named?
4. date_extractable — is there a discernible announcement date?
5. source_credibility — is the source a credible news outlet or company press release?
6. not_commentary — not an opinion piece, explainer, or market report?
7. not_policy_debate — not a parliamentary or government policy discussion?
8. not_personal_anecdote — not a personal story?

## Allowed Industries
Tech, Finance, Manufacturing, Retail, F&B, Real Estate, Healthcare, Education, Other

## Headcount Scope — Singapore vs global
This tracker counts SINGAPORE jobs only. Split the headcount into two fields:
- "jobs_cut_sg" — number of SINGAPORE roles cut (only when the figure is specifically
  Singapore staff). Otherwise null.
- "jobs_cut_global" — the worldwide/foreign/regional figure the source gave (e.g.
  "18,000 jobs globally", "1,000 jobs in Britain", "8,000 back-office roles"). Otherwise null.
A worldwide or foreign figure MUST go in jobs_cut_global, NEVER jobs_cut_sg. If the
number is Singapore-specific, use jobs_cut_sg and leave jobs_cut_global null. If no
headcount is disclosed, both are null.

## Event date vs report date
- "date_announced" — when the layoff event happened / was announced by the company.
- "date_reported" — the article's publication date (may be later; follow-up coverage).

## Event id
"event_id" is a kebab-case slug identifying the underlying layoff EVENT (e.g.
"standard-chartered-2026-ai"). If this story is follow-up coverage of an event that
already appears in the "Existing events for this company" list below, REUSE that exact
event_id. Only mint a new slug (company-YYYY-MM) when it is a genuinely new event.

## Output
Return ONLY a valid JSON object (no markdown, no extra text):
{
  "verdict": "confirmed" | "rumored" | "rejected" | "needs_review",
  "confidence": "high" | "medium" | "low",
  "company": "Company Name",
  "industry": "<one of the allowed industries>",
  "date_announced": "YYYY-MM-DD",
  "date_reported": "YYYY-MM-DD",
  "jobs_cut_sg": <integer or null>,
  "jobs_cut_global": <integer or null>,
  "pct_workforce": <number or null>,
  "event_id": "kebab-case-slug",
  "notes": "1–2 sentence reason for your decision",
  "rejection_reason": "<commentary|statistics|policy|job-posting|not-sg|duplicate|personal|aggregator|legal> (only when verdict=rejected)"
}`;

// Existing events per normalized company — lets the model reuse an event_id when the
// queue row is follow-up coverage of an already-tracked event.
type EventHint = { event_id: string; date_announced: string; company: string };
function buildEventIndex(layoffs: LayoffEntry[]): Map<string, EventHint[]> {
  const byCompany = new Map<string, Map<string, EventHint>>();
  for (const e of layoffs) {
    if (!e.event_id) continue;
    const key = normalizeCompany(e.company || '').toLowerCase();
    if (!byCompany.has(key)) byCompany.set(key, new Map());
    const seen = byCompany.get(key)!;
    if (!seen.has(e.event_id)) {
      seen.set(e.event_id, { event_id: e.event_id, date_announced: e.date_announced, company: e.company });
    }
  }
  const out = new Map<string, EventHint[]>();
  for (const [k, m] of byCompany) out.set(k, [...m.values()]);
  return out;
}

function buildUserPrompt(entry: LayoffEntry, eventIndex: Map<string, EventHint[]>): string {
  const lines: string[] = [
    `Title/Company: ${entry.company}`,
    `Date: ${entry.date_announced}`,
    `Source URL: ${entry.source_link}`,
  ];
  const sg = entry.jobs_cut_sg;
  const global = entry.jobs_cut_global;
  if (sg != null) lines.push(`Jobs cut SG (scraped): ${sg}`);
  if (global != null) lines.push(`Jobs cut global (scraped): ${global}`);
  if (entry.pct_workforce != null) lines.push(`% workforce (scraped): ${entry.pct_workforce}`);
  if (entry.notes) lines.push(`Notes/snippet: ${entry.notes}`);

  const hints = eventIndex.get(normalizeCompany(entry.company || '').toLowerCase());
  if (hints && hints.length > 0) {
    lines.push('Existing events for this company (reuse an event_id if this is follow-up coverage):');
    for (const h of hints.slice(0, 12)) {
      lines.push(`  - ${h.event_id} (${h.date_announced})`);
    }
  }
  return lines.join('\n');
}

// Try providers in order, falling back on API errors.
// Returns the verdict and which provider ultimately succeeded.
async function evaluateEntry(
  chain: ProviderConfig[],
  entry: LayoffEntry,
  eventIndex: Map<string, EventHint[]>
): Promise<{ verdict: LLMVerdict; provider: string }> {
  const errors: string[] = [];

  for (const provider of chain) {
    try {
      const response = await provider.client.chat.completions.create({
        model: provider.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(entry, eventIndex) },
        ],
        temperature: 0,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0]?.message?.content || '{}';

      try {
        return { verdict: coerceVerdict(raw, entry), provider: provider.name };
      } catch {
        // Malformed JSON from this provider — treat as a soft failure and try the next
        errors.push(`${provider.name}: JSON parse error (raw: ${raw.slice(0, 80)})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${provider.name}: ${msg}`);
      process.stdout.write(` [${provider.name} failed, trying next]`);
    }
  }

  // All providers failed
  return {
    verdict: {
      verdict: 'needs_review',
      confidence: 'low',
      company: entry.company,
      industry: 'Other',
      date_announced: entry.date_announced,
      date_reported: entry.date_reported,
      jobs_cut_sg: entry.jobs_cut_sg,
      jobs_cut_global: entry.jobs_cut_global,
      pct_workforce: entry.pct_workforce,
      event_id: entry.event_id,
      notes: `All providers failed: ${errors.join(' | ')}`,
    },
    provider: 'none',
  };
}

async function main() {
  const queue = readCsv('review-queue.csv') as LayoffEntry[];

  if (queue.length === 0) {
    console.log('Review queue is empty — nothing to triage.');
    fs.writeFileSync(
      'data/llm-triage-summary.json',
      JSON.stringify(
        { run_date: new Date().toISOString().slice(0, 10), providers: [], total: 0, confirmed: 0, rumored: 0, rejected: 0, needs_review: 0, remaining_queue: 0, rows: [] },
        null,
        2
      ) + '\n'
    );
    return;
  }

  // Existing events index, so the model can reuse an event_id for follow-up coverage.
  const existingLayoffs = readCsv('layoffs.csv') as LayoffEntry[];
  const eventIndex = buildEventIndex(existingLayoffs);

  const chain = getProviderChain();
  const providerNames = chain.map((p) => `${p.name}(${p.model})`).join(' → ');
  console.log(`LLM triage: ${queue.length} entr${queue.length === 1 ? 'y' : 'ies'}`);
  console.log(`Provider chain: ${providerNames}\n`);

  const accepted: LayoffEntry[] = [];
  const rejected: LayoffEntry[] = [];
  const remaining: LayoffEntry[] = [];
  const summaryRows: SummaryRow[] = [];

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    process.stdout.write(`  [${i + 1}/${queue.length}] ${entry.company.slice(0, 50).padEnd(50)} `);

    const { verdict, provider } = await evaluateEntry(chain, entry, eventIndex);
    console.log(`→ ${verdict.verdict} (${verdict.confidence}) [${provider}]`);

    summaryRows.push({
      original_company: entry.company,
      llm_company: verdict.company,
      source_link: entry.source_link,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      provider,
      notes: verdict.notes,
      rejection_reason: verdict.rejection_reason ?? undefined,
    });

    const date_announced = verdict.date_announced || entry.date_announced;
    const layoffEntry: LayoffEntry = {
      company: verdict.company,
      date_announced,
      date_reported: verdict.date_reported || entry.date_reported || entry.date_announced,
      jobs_cut_sg: verdict.jobs_cut_sg,
      jobs_cut_global: verdict.jobs_cut_global,
      pct_workforce: verdict.pct_workforce,
      industry: verdict.industry,
      source_link: entry.source_link,
      notes: verdict.notes,
      status: (verdict.verdict === 'confirmed' || verdict.verdict === 'rumored')
        ? verdict.verdict
        : (entry.status as LayoffEntry['status']) || 'rumored',
      event_id: verdict.event_id || entry.event_id || eventIdFor(verdict.company, date_announced),
    };

    if (verdict.verdict === 'confirmed' || verdict.verdict === 'rumored') {
      accepted.push(layoffEntry);
    } else if (verdict.verdict === 'rejected') {
      rejected.push({
        ...layoffEntry,
        notes: `[LLM rejected: ${verdict.rejection_reason || 'see notes'}] ${verdict.notes}`,
      });
    } else {
      remaining.push(entry);
    }
  }

  if (accepted.length > 0) appendCsv('layoffs.csv', accepted);
  if (rejected.length > 0) appendCsv('rejected.csv', rejected);
  writeCsv('review-queue.csv', remaining);

  const summary = {
    run_date: new Date().toISOString().slice(0, 10),
    providers: chain.map((p) => ({ name: p.name, model: p.model })),
    total: queue.length,
    confirmed: summaryRows.filter((r) => r.verdict === 'confirmed').length,
    rumored: summaryRows.filter((r) => r.verdict === 'rumored').length,
    rejected: summaryRows.filter((r) => r.verdict === 'rejected').length,
    needs_review: summaryRows.filter((r) => r.verdict === 'needs_review').length,
    remaining_queue: remaining.length,
    rows: summaryRows,
  };

  fs.writeFileSync('data/llm-triage-summary.json', JSON.stringify(summary, null, 2) + '\n');

  console.log(`
Summary:
  Provider chain  : ${providerNames}
  Total evaluated : ${summary.total}
  Confirmed       : ${summary.confirmed}
  Rumored         : ${summary.rumored}
  Rejected        : ${summary.rejected}
  Needs review    : ${summary.needs_review}
  Remaining queue : ${summary.remaining_queue}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
