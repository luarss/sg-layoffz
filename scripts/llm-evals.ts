// Benchmark suite that measures LLM classification accuracy against historical data.
// Samples entries from layoffs.csv (expected: accept) and rejected.csv (expected: reject),
// runs each through the LLM evaluator, and reports precision / recall / F1.
// Uses the same provider fallback chain as llm-triage.ts (DS → MiMo → OpenRouter).
//
// Usage:
//   DEEPSEEK_API_KEY=sk-... npm run eval:llm
//   DEEPSEEK_API_KEY=sk-... npm run eval:llm -- --samples 10  (10 from each category)

import OpenAI from 'openai';
import { readCsv } from '../src/lib/csv';
import { LayoffEntry } from '../src/lib/types';
import { LLMVerdict, parseVerdict } from '../src/lib/verdict';

// ---- Eval categories -------------------------------------------------------
// Each category tests a specific rejection/acceptance signal.
// We label rejected.csv entries by which keyword pattern they match.
const EVAL_REJECTION_CATEGORIES: { label: string; test: (e: LayoffEntry) => boolean }[] = [
  {
    label: 'commentary',
    test: (e) =>
      /commentary:|explainer:|deep dive|opinion|analysis|why are there|what could/i.test(
        `${e.company} ${e.notes}`
      ),
  },
  {
    label: 'policy',
    test: (e) =>
      /parliament|mom data|mom to review|manpower minister|ntuc|advance notice|mandatory/i.test(
        `${e.company} ${e.notes}`
      ),
  },
  {
    label: 'personal',
    test: (e) =>
      /i got laid|laid-off tech|i applied to|i had 10|i am tired|retrenched at 22/i.test(
        `${e.company} ${e.notes}`
      ),
  },
  {
    label: 'job-posting',
    test: (e) =>
      /job posting|career|hirevector|hiring|indeed|glassdoor|linkedin/i.test(
        `${e.source_link} ${e.notes}`
      ),
  },
  {
    label: 'statistics',
    test: (e) =>
      /labour market|employment growth|1,270 layoffs|43%|retrenchments rise/i.test(
        `${e.company} ${e.notes}`
      ),
  },
  {
    // Largest rejection category. Covers foreign-operations-only stories and global
    // announcements with no stated Singapore nexus — the same failure mode that caused
    // IKEA and Nestlé false negatives in the last eval run.
    label: 'not-sg',
    test: (e) =>
      /not-sg|no (?:clear )?singapore nexus|no mention of singapore|does not mention.*singapore|no singapore/i.test(
        e.notes ?? ''
      ),
  },
  {
    // Aggregator articles covering many companies at once. The LLM is asked to classify
    // a single event in isolation so these must be rejected.
    label: 'aggregator',
    test: (e) =>
      /aggregator|covering (?:many|multiple) companies|multiple companies|list of.*layoffs|tracker/i.test(
        e.notes ?? ''
      ),
  },
];

function categoriseRejected(e: LayoffEntry): string {
  for (const cat of EVAL_REJECTION_CATEGORIES) {
    if (cat.test(e)) return cat.label;
  }
  return 'other';
}

// ---- Provider chain (mirrors llm-triage.ts: DS → MiMo → OpenRouter) --------
interface ProviderConfig {
  name: string;
  client: OpenAI;
  model: string;
}

function getProviderChain(): ProviderConfig[] {
  const force = process.env.LLM_PROVIDER;
  const chain: ProviderConfig[] = [];
  const want = (name: string) => !force || force === name;

  if (want('deepseek') && process.env.DEEPSEEK_API_KEY) {
    chain.push({
      name: 'deepseek',
      client: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' }),
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    });
  }

  if (want('mimo') && process.env.MIMO_API_KEY && process.env.MIMO_BASE_URL) {
    chain.push({
      name: 'mimo',
      client: new OpenAI({ apiKey: process.env.MIMO_API_KEY, baseURL: process.env.MIMO_BASE_URL }),
      model: process.env.MIMO_MODEL || 'mimo-v2.5',
    });
  }

  if (want('openrouter') && process.env.OPENROUTER_API_KEY) {
    chain.push({
      name: 'openrouter',
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: { 'HTTP-Referer': 'https://github.com/luarss/sg-layoffz', 'X-Title': 'sg-layoffz' },
      }),
      model: process.env.OPENROUTER_MODEL || 'openrouter/owl-alpha',
    });
  }

  if (chain.length === 0) {
    throw new Error('No LLM provider configured. Set DEEPSEEK_API_KEY, MIMO_API_KEY+MIMO_BASE_URL, or OPENROUTER_API_KEY');
  }

  return chain;
}

function describeChain(chain: ProviderConfig[]): string {
  return chain.map((p) => `${p.name}(${p.model})`).join(' → ');
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evaluateEntry(chain: ProviderConfig[], entry: LayoffEntry): Promise<LLMVerdict> {
  for (const provider of chain) {
    // Retry transient failures (rate limits, 5xx, truncated/empty completions) with
    // backoff before giving up on this provider. Under concurrency these are common
    // and previously fell straight through to needs_review — a spurious miss that
    // made the score flap around the pass threshold.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
        // Zod-validated against the shared VerdictSchema: a partial/empty response
        // (e.g. '{}') or one missing a valid verdict returns null, so we retry and
        // then fall through to the next provider instead of emitting an `undefined`
        // verdict.
        const parsed = parseVerdict(raw);
        if (parsed) return parsed;
      } catch {
        // transient API error — fall through to backoff/retry
      }
      if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt);
    }
  }
  return {
    verdict: 'needs_review',
    confidence: 'low',
    company: entry.company,
    industry: 'Other',
    date_announced: entry.date_announced,
    jobs_cut: null,
    pct_workforce: null,
    notes: 'All providers failed',
  };
}

// ---- Sampling ---------------------------------------------------------------
// Seeded RNG so a run is reproducible (a stable CI signal that doesn't flap from
// random sampling). Override with `--seed <n>`; defaults to a fixed seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng: () => number = Math.random; // replaced in main() once the seed is known

function sample<T>(arr: T[], n: number): T[] {
  // Fisher–Yates shuffle (the sort-by-random comparator is biased), then take n.
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, arr.length));
}

function sampleStratified(entries: LayoffEntry[], n: number): { entry: LayoffEntry; category: string }[] {
  const byCategory: Record<string, LayoffEntry[]> = {};
  for (const e of entries) {
    const cat = categoriseRejected(e);
    byCategory[cat] = byCategory[cat] || [];
    byCategory[cat].push(e);
  }

  const cats = Object.keys(byCategory);
  const perCat = Math.max(1, Math.floor(n / cats.length));
  const result: { entry: LayoffEntry; category: string }[] = [];

  for (const cat of cats) {
    for (const entry of sample(byCategory[cat], perCat)) {
      result.push({ entry, category: cat });
    }
  }

  // Fill remaining slots randomly
  const remaining = n - result.length;
  if (remaining > 0) {
    const used = new Set(result.map((r) => r.entry.source_link));
    const extra = entries.filter((e) => !used.has(e.source_link));
    for (const entry of sample(extra, remaining)) {
      result.push({ entry, category: categoriseRejected(entry) });
    }
  }

  return result.slice(0, n);
}

// ---- Metrics ----------------------------------------------------------------
function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

// ---- Main -------------------------------------------------------------------
async function main() {
  const samplesArg = process.argv.indexOf('--samples');
  const samplesPerClass = samplesArg !== -1 ? parseInt(process.argv[samplesArg + 1], 10) : 20;

  const seedArg = process.argv.indexOf('--seed');
  const seed = seedArg !== -1 ? parseInt(process.argv[seedArg + 1], 10) : 1234;
  rng = mulberry32(seed);

  const allLayoffs = readCsv('layoffs.csv') as LayoffEntry[];
  const allRejected = readCsv('rejected.csv') as LayoffEntry[];

  // Filter rejected entries that look like real data (not job postings which are obvious)
  const withData = allRejected.filter((e) => e.company && e.source_link);

  // Exclude duplicate-rejections from the eval's reject set. These entries ARE real
  // layoffs — they were rejected only for duplicating an already-tracked event. The
  // LLM evaluator classifies one article in isolation and cannot detect duplicates;
  // de-duplication is a separate downstream step (scripts/dedup-layoffs.ts). Scoring
  // the model against them measures something it is not responsible for and is the
  // root cause of most false positives.
  const isDuplicateRejection = (e: LayoffEntry) => /duplicate/i.test(e.notes || '');
  const meaningfulRejected = withData.filter((e) => !isDuplicateRejection(e));
  const excludedDupes = withData.length - meaningfulRejected.length;

  const acceptSample = sample(allLayoffs, samplesPerClass);
  const rejectSample = sampleStratified(meaningfulRejected, samplesPerClass);

  const chain = getProviderChain();
  const total = acceptSample.length + rejectSample.length;
  console.log(`\nLLM Eval — chain: ${describeChain(chain)} (seed: ${seed})`);
  console.log(`Samples: ${acceptSample.length} from layoffs.csv, ${rejectSample.length} from rejected.csv`);
  console.log(`Excluded ${excludedDupes} duplicate-rejections from reject pool (not LLM-detectable)\n`);

  type EvalRow = {
    entry: LayoffEntry;
    groundTruth: 'accept' | 'reject';
    category: string;
    verdict: LLMVerdict;
    correct: boolean;
  };

  const results: EvalRow[] = [];
  let done = 0;

  async function run(entry: LayoffEntry, groundTruth: 'accept' | 'reject', category: string) {
    const verdict = await evaluateEntry(chain, entry);
    const llmAccepts = verdict.verdict === 'confirmed' || verdict.verdict === 'rumored';
    const correct = groundTruth === 'accept' ? llmAccepts : !llmAccepts;
    results.push({ entry, groundTruth, category, verdict, correct });
    done++;
    process.stdout.write(`\r  Progress: ${done}/${total}`);
  }

  const tasks: Promise<void>[] = [];
  for (const entry of acceptSample) tasks.push(run(entry, 'accept', 'layoff'));
  for (const { entry, category } of rejectSample) tasks.push(run(entry, 'reject', category));

  // Run concurrently with a small concurrency limit to avoid rate limits
  const CONCURRENCY = 3;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + CONCURRENCY));
  }

  console.log('\n');

  // ---- Compute metrics ----
  const tp = results.filter((r) => r.groundTruth === 'accept' && r.correct).length;
  const fp = results.filter((r) => r.groundTruth === 'reject' && !r.correct).length;
  const tn = results.filter((r) => r.groundTruth === 'reject' && r.correct).length;
  const fn = results.filter((r) => r.groundTruth === 'accept' && !r.correct).length;

  const accuracy = (tp + tn) / total;
  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;

  console.log('='.repeat(60));
  console.log('OVERALL METRICS');
  console.log('='.repeat(60));
  console.log(`  Accuracy  : ${pct(tp + tn, total)} (${tp + tn}/${total})`);
  console.log(`  Precision : ${pct(tp, tp + fp)} — of LLM accepts, how many were correct`);
  console.log(`  Recall    : ${pct(tp, tp + fn)} — of real layoffs, how many did LLM catch`);
  console.log(`  F1        : ${(f1(precision, recall) * 100).toFixed(1)}%`);
  console.log(`\n  True Positives  : ${tp}  (correctly accepted)`);
  console.log(`  True Negatives  : ${tn}  (correctly rejected)`);
  console.log(`  False Positives : ${fp}  (incorrectly accepted — noise let through)`);
  console.log(`  False Negatives : ${fn}  (incorrectly rejected — real layoffs missed)`);

  // ---- Per-category breakdown ----
  const categories = [...new Set(results.map((r) => r.category))];
  console.log('\n' + '='.repeat(60));
  console.log('PER-CATEGORY BREAKDOWN (rejection accuracy)');
  console.log('='.repeat(60));
  for (const cat of categories.sort()) {
    const rows = results.filter((r) => r.category === cat);
    const correct = rows.filter((r) => r.correct).length;
    console.log(`  ${cat.padEnd(20)} ${pct(correct, rows.length).padStart(7)}  (${correct}/${rows.length})`);
  }

  // ---- Errors ----
  const errors = results.filter((r) => !r.correct);
  if (errors.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('ERRORS (misclassified entries)');
    console.log('='.repeat(60));
    for (const e of errors) {
      const llmSaid = e.verdict.verdict;
      console.log(
        `\n  [${e.groundTruth.toUpperCase()} → LLM said ${llmSaid}] ${e.entry.company.slice(0, 70)}`
      );
      console.log(`    URL: ${e.entry.source_link.slice(0, 80)}`);
      console.log(`    LLM notes: ${e.verdict.notes}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Eval complete — ${accuracy >= 0.85 ? '✓ PASS' : '✗ FAIL'} (threshold: 85% accuracy)`);
  console.log('='.repeat(60) + '\n');

  if (accuracy < 0.85) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
