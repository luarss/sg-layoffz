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
//
// Environment variables:
//   DEEPSEEK_API_KEY    DeepSeek key  (base URL: https://api.deepseek.com/v1)
//   DEEPSEEK_MODEL      model override (default: deepseek-v4-flash)
//   MIMO_API_KEY        MiMo key
//   MIMO_BASE_URL       MiMo OpenAI-compatible endpoint
//   MIMO_MODEL          model override (default: mimo-v2.5)
//   OPENROUTER_API_KEY  OpenRouter key (base URL: https://openrouter.ai/api/v1)
//   OPENROUTER_MODEL    model override (default: openrouter/owl-alpha)
//   LLM_PROVIDER        force a single provider: deepseek | mimo | openrouter

import fs from 'node:fs';
import OpenAI from 'openai';
import { readCsv, appendCsv, writeCsv } from '../src/lib/csv';
import { LayoffEntry, INDUSTRIES } from '../src/lib/types';

type Verdict = 'confirmed' | 'rumored' | 'rejected' | 'needs_review';
type Confidence = 'high' | 'medium' | 'low';
type Industry = (typeof INDUSTRIES)[number];

interface LLMVerdict {
  verdict: Verdict;
  confidence: Confidence;
  company: string;
  industry: Industry;
  date_announced: string;
  jobs_cut: number | null;
  pct_workforce: number | null;
  notes: string;
  rejection_reason?: string;
}

interface ProviderConfig {
  name: string;
  client: OpenAI;
  model: string;
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

// Build the ordered provider chain from available env vars.
// If LLM_PROVIDER is set, only that provider is included (no fallback).
function getProviderChain(): ProviderConfig[] {
  const force = process.env.LLM_PROVIDER;
  const chain: ProviderConfig[] = [];

  const want = (name: string) => !force || force === name;

  if (want('deepseek') && process.env.DEEPSEEK_API_KEY) {
    chain.push({
      name: 'deepseek',
      client: new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com/v1',
      }),
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    });
  }

  if (want('mimo') && process.env.MIMO_API_KEY && process.env.MIMO_BASE_URL) {
    chain.push({
      name: 'mimo',
      client: new OpenAI({
        apiKey: process.env.MIMO_API_KEY,
        baseURL: process.env.MIMO_BASE_URL,
      }),
      model: process.env.MIMO_MODEL || 'mimo-v2.5',
    });
  }

  if (want('openrouter') && process.env.OPENROUTER_API_KEY) {
    chain.push({
      name: 'openrouter',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/luarss/sg-layoffz',
          'X-Title': 'sg-layoffz',
        },
      }),
      model: process.env.OPENROUTER_MODEL || 'openrouter/owl-alpha',
    });
  }

  if (chain.length === 0) {
    throw new Error(
      'No LLM provider configured. Set at least one of:\n' +
      '  DEEPSEEK_API_KEY\n' +
      '  MIMO_API_KEY + MIMO_BASE_URL\n' +
      '  OPENROUTER_API_KEY'
    );
  }

  return chain;
}

const SYSTEM_PROMPT = `You are an expert analyst for a Singapore layoff tracking database. Evaluate news articles about potential Singapore layoff events and classify each one.

## Classification Rules

**CONFIRMED** — all must be true:
- Officially announced or credibly reported job cuts/retrenchment
- Specific named company with Singapore operations
- Already happened or actively underway (not a future plan)

**RUMORED** — same as confirmed but:
- Planned, anticipated, or reported as likely ("plans to cut", "expected to retrench", "may lay off")

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

## Output
Return ONLY a valid JSON object (no markdown, no extra text):
{
  "verdict": "confirmed" | "rumored" | "rejected" | "needs_review",
  "confidence": "high" | "medium" | "low",
  "company": "Company Name",
  "industry": "<one of the allowed industries>",
  "date_announced": "YYYY-MM-DD",
  "jobs_cut": <integer or null>,
  "pct_workforce": <number or null>,
  "notes": "1–2 sentence reason for your decision",
  "rejection_reason": "<commentary|statistics|policy|job-posting|not-sg|duplicate|personal|aggregator|legal> (only when verdict=rejected)"
}`;

function buildUserPrompt(entry: LayoffEntry): string {
  const lines: string[] = [
    `Title/Company: ${entry.company}`,
    `Date: ${entry.date_announced}`,
    `Source URL: ${entry.source_link}`,
  ];
  if (entry.jobs_cut != null) lines.push(`Jobs cut (scraped): ${entry.jobs_cut}`);
  if (entry.pct_workforce != null) lines.push(`% workforce (scraped): ${entry.pct_workforce}`);
  if (entry.notes) lines.push(`Notes/snippet: ${entry.notes}`);
  return lines.join('\n');
}

function parseVerdict(raw: string, entry: LayoffEntry): LLMVerdict {
  const p = JSON.parse(raw) as Partial<LLMVerdict>;
  return {
    verdict: (['confirmed', 'rumored', 'rejected', 'needs_review'] as const).includes(p.verdict as Verdict)
      ? (p.verdict as Verdict)
      : 'needs_review',
    confidence: (['high', 'medium', 'low'] as const).includes(p.confidence as Confidence)
      ? (p.confidence as Confidence)
      : 'low',
    company: p.company || entry.company,
    industry: (INDUSTRIES as readonly string[]).includes(p.industry as string)
      ? (p.industry as Industry)
      : 'Other',
    date_announced: /^\d{4}-\d{2}-\d{2}$/.test(p.date_announced || '')
      ? p.date_announced!
      : entry.date_announced,
    jobs_cut: typeof p.jobs_cut === 'number' ? p.jobs_cut : entry.jobs_cut,
    pct_workforce: typeof p.pct_workforce === 'number' ? p.pct_workforce : entry.pct_workforce,
    notes: (typeof p.notes === 'string' && p.notes) ? p.notes : '',
    rejection_reason: p.rejection_reason,
  };
}

// Try providers in order, falling back on API errors.
// Returns the verdict and which provider ultimately succeeded.
async function evaluateEntry(
  chain: ProviderConfig[],
  entry: LayoffEntry
): Promise<{ verdict: LLMVerdict; provider: string }> {
  const errors: string[] = [];

  for (const provider of chain) {
    try {
      const response = await provider.client.chat.completions.create({
        model: provider.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(entry) },
        ],
        temperature: 0,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0]?.message?.content || '{}';

      try {
        return { verdict: parseVerdict(raw, entry), provider: provider.name };
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
      jobs_cut: entry.jobs_cut,
      pct_workforce: entry.pct_workforce,
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

    const { verdict, provider } = await evaluateEntry(chain, entry);
    console.log(`→ ${verdict.verdict} (${verdict.confidence}) [${provider}]`);

    summaryRows.push({
      original_company: entry.company,
      llm_company: verdict.company,
      source_link: entry.source_link,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      provider,
      notes: verdict.notes,
      rejection_reason: verdict.rejection_reason,
    });

    const layoffEntry: LayoffEntry = {
      company: verdict.company,
      date_announced: verdict.date_announced,
      jobs_cut: verdict.jobs_cut,
      pct_workforce: verdict.pct_workforce,
      industry: verdict.industry,
      source_link: entry.source_link,
      notes: verdict.notes,
      status: (verdict.verdict === 'confirmed' || verdict.verdict === 'rumored')
        ? verdict.verdict
        : (entry.status as LayoffEntry['status']) || 'rumored',
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
