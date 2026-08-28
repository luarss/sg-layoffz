import fs from 'node:fs';
import { readCsv, appendCsv } from '../src/lib/csv';
import { ReviewEntry } from '../src/lib/types';
import { normalizeCompany, parseDate, extractJobsFromText } from './normalize';
import { isDuplicate } from './deduplicate';
import { searchExa, searchTinyFish, titleFingerprint, SearchHit } from './search';

// Exa is semantic, so natural-language intent queries beat bare keywords.
//
// CORE queries run every day — broad nets that catch breaking, cross-sector
// coverage. ROTATING queries are sector/angle-specific; each day we slide a
// window across them so the net shifts day-to-day instead of re-pulling the
// same top stories. CORE + a window of ROTATING fills the daily run cap.
const CORE_QUERIES = [
  'Singapore company announces layoffs or retrenchment of employees',
  'Singapore tech company cuts jobs or shuts down operations',
  'multinational company closing its Singapore office or regional headquarters',
  'Singapore startup lays off staff after funding or revenue trouble',
];

const ROTATING_QUERIES = [
  'Singapore bank or financial services firm reducing headcount',
  'Singapore manufacturing plant or factory closure and retrenchment',
  'Singapore retail chain closing stores and laying off workers',
  'Singapore food and beverage outlets shutting down with jobs lost',
  'Singapore logistics, shipping or aviation workforce reduction',
  'Singapore healthcare or pharmaceutical company cutting jobs',
  'Singapore media, advertising or marketing agency layoffs',
  'Singapore gaming, fintech or crypto company retrenchment',
  'Singapore real estate or construction firm downsizing staff',
  'Singapore e-commerce or delivery platform cutting headcount',
  'Singapore semiconductor or electronics plant job losses',
  'Singapore professional services or consulting firm redundancies',
  'Ministry of Manpower Singapore retrenchment figures rising',
  'Singapore SME or business closure leaving workers retrenched',
];

// Day-of-year offset, so the rotating window advances one query per day and
// cycles through the whole pool over time.
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((today - start) / 86_400_000);
}

function buildQueries(today: Date): string[] {
  const offset = dayOfYear(today) % ROTATING_QUERIES.length;
  const rotated = [
    ...ROTATING_QUERIES.slice(offset),
    ...ROTATING_QUERIES.slice(0, offset),
  ];
  // CORE first (always issued), then the day's rotating window. The run-cap
  // `allowance` below truncates this list to the searches we're allowed today.
  return [...CORE_QUERIES, ...rotated];
}

const RESULTS_PER_QUERY = 10;
const LOOKBACK_DAYS = 14;
const DEFAULT_MONTHLY_CAP = 1000;
const DEFAULT_RUN_CAP = 10;

const BUDGET_PATH = `${process.cwd()}/data/exa-budget.json`;

interface BudgetState {
  month: string; // YYYY-MM
  searches_used: number;
  monthly_cap: number;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function loadBudget(): BudgetState {
  const month = currentMonth();
  if (!fs.existsSync(BUDGET_PATH)) {
    return { month, searches_used: 0, monthly_cap: DEFAULT_MONTHLY_CAP };
  }
  const raw = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf-8')) as Partial<BudgetState>;
  const state: BudgetState = {
    month: raw.month || month,
    searches_used: raw.searches_used ?? 0,
    monthly_cap: raw.monthly_cap ?? DEFAULT_MONTHLY_CAP,
  };
  if (state.month !== month) {
    state.month = month;
    state.searches_used = 0;
  }
  return state;
}

function saveBudget(state: BudgetState): void {
  fs.writeFileSync(BUDGET_PATH, JSON.stringify(state, null, 2) + '\n');
}

function resultToReviewEntry(r: SearchHit, index: number): ReviewEntry {
  const title = r.title || r.url;
  const text = r.snippet || '';
  const combined = `${title}. ${text}`;
  const company = normalizeCompany(
    title.split(/cuts?|lays? off|retrench|sheds?/i)[0] || title
  );

  return {
    review_id: `exa-${Date.now()}-${index}`,
    company,
    date_announced: parseDate(r.publishedDate || '') || new Date().toISOString().slice(0, 10),
    date_reported: parseDate(r.publishedDate || '') || new Date().toISOString().slice(0, 10),
    // Scraped headcount is unscoped at ingestion; default to SG, re-scoped by triage.
    jobs_cut_sg: extractJobsFromText(combined),
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Other',
    source_link: r.url,
    notes: `From Exa [gn:${titleFingerprint(title)}]`,
    status: 'rumored',
    event_id: '',
    candidate_urls: r.url,
    snippet: text.slice(0, 300),
  };
}

// TinyFish fallback for a single query, with logging and error-swallowing so a
// failed fallback never aborts the run (mirrors how Exa failures are handled).
async function tinyFishFallback(
  apiKey: string,
  query: string,
  startDate: string,
  endDate: string
): Promise<SearchHit[]> {
  try {
    const results = await searchTinyFish(apiKey, query, {
      numResults: RESULTS_PER_QUERY,
      startPublishedDate: startDate,
      endPublishedDate: endDate,
    });
    console.log(`    [tinyfish] fallback returned ${results.length} results`);
    return results;
  } catch (err) {
    console.error(`    TinyFish fallback failed: ${(err as Error).message}`);
    return [];
  }
}

function emitResult(newEntries: number, dupes: number, potential: number) {
  console.log(
    `SCRAPE_RESULT:source=exa,new_entries=${newEntries},duplicates=${dupes},potential_dupes=${potential}`
  );
}

async function main() {
  console.log('🔍 Scraping Exa for Singapore layoff coverage...\n');

  const exaKey = process.env.EXA_API_KEY;
  const tinyfishKey = process.env.TINYFISH_API_KEY;
  if (!exaKey && !tinyfishKey) {
    console.log('  Neither EXA_API_KEY nor TINYFISH_API_KEY set — skipping Exa scrape.');
    emitResult(0, 0, 0);
    return;
  }

  const budget = loadBudget();
  const remaining = exaKey ? budget.monthly_cap - budget.searches_used : 0;
  if (exaKey) {
    console.log(
      `  Budget: ${budget.searches_used}/${budget.monthly_cap} used this month (${budget.month}); ${remaining} remaining.`
    );
  }

  // Exa is the primary provider; TinyFish is the free fallback. Exa is "unavailable"
  // when there's no key or the monthly budget is spent — in which case we run the
  // whole plan through TinyFish instead of skipping the step entirely.
  const exaUnavailable = !exaKey || remaining <= 0;
  if (exaUnavailable && !tinyfishKey) {
    console.log('  Monthly budget exhausted — skipping Exa scrape.');
    emitResult(0, 0, 0);
    saveBudget(budget); // persists potential month rollover even on no-op
    return;
  }
  if (exaUnavailable && tinyfishKey) {
    console.log('  Exa unavailable (no key or budget exhausted) — using TinyFish fallback.');
  }

  const runCap = parseInt(process.env.EXA_RUN_CAP || '', 10) || DEFAULT_RUN_CAP;
  // When Exa drives the run, cap by its remaining budget. When falling back to
  // TinyFish (free), only the per-run cap applies.
  const allowance = exaUnavailable ? runCap : Math.min(remaining, runCap);
  console.log(`  This run will issue up to ${allowance} search(es).`);

  const today = new Date();
  const endDate = today.toISOString();
  const start = new Date(today);
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const startDate = start.toISOString();
  const QUERIES = buildQueries(today);
  console.log(`  Query plan (${QUERIES.length} candidates, capped at ${allowance}):`);
  const layoffs = readCsv('layoffs.csv');
  const reviewQueue = readCsv('review-queue.csv') as ReviewEntry[];
  const rejected = readCsv('rejected.csv');

  const allResults: SearchHit[] = [];
  let issued = 0;
  let skipped = 0;

  for (const query of QUERIES) {
    if (issued >= allowance) {
      skipped++;
      continue;
    }
    console.log(`  Query: "${query}"`);
    issued++;

    // Per query, use Exa while it has a key and budget; otherwise fall back to
    // TinyFish. A mid-run Exa failure also falls through to TinyFish when keyed.
    const useExa = exaKey && budget.searches_used < budget.monthly_cap;
    let results: SearchHit[] = [];

    if (useExa) {
      budget.searches_used++;
      try {
        results = await searchExa(exaKey, query, {
          numResults: RESULTS_PER_QUERY,
          startPublishedDate: startDate,
          endPublishedDate: endDate,
          maxCharacters: 800,
        });
      } catch (err) {
        console.error(`    Failed: ${(err as Error).message}`);
        if (tinyfishKey) {
          results = await tinyFishFallback(tinyfishKey, query, startDate, endDate);
        }
      }
      // Persist after every call so a crash mid-run doesn't reset the counter.
      saveBudget(budget);
    } else if (tinyfishKey) {
      results = await tinyFishFallback(tinyfishKey, query, startDate, endDate);
    }

    console.log(`    Found ${results.length} results`);
    allResults.push(...results);
    await new Promise((r) => setTimeout(r, 500));
  }

  if (skipped > 0) {
    console.log(`  Skipped ${skipped} query(ies) to stay within budget/run-cap.`);
  }

  // Dedup within this run: by URL, then by title fingerprint.
  const seenUrls = new Set<string>();
  const seenFingerprints = new Set<string>();
  const unique = allResults.filter((r) => {
    if (!r.url || seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    const fp = titleFingerprint(r.title || r.url);
    if (fp && seenFingerprints.has(fp)) return false;
    if (fp) seenFingerprints.add(fp);
    return true;
  });

  console.log(`\n  Total unique results: ${unique.length}`);

  const newEntries: ReviewEntry[] = [];
  let dupes = 0;
  let potentialDupes = 0;
  const seenCompanyDates = new Set<string>();

  for (let i = 0; i < unique.length; i++) {
    const entry = resultToReviewEntry(unique[i], i);

    const cdKey = `${normalizeCompany(entry.company).toLowerCase()}||${entry.date_announced}`;
    if (seenCompanyDates.has(cdKey)) {
      dupes++;
      continue;
    }

    const result = isDuplicate(entry, layoffs, reviewQueue, rejected);

    if (result === 'new') {
      newEntries.push(entry);
      seenCompanyDates.add(cdKey);
    } else if (result === 'duplicate') {
      dupes++;
    } else {
      potentialDupes++;
      newEntries.push(entry);
      seenCompanyDates.add(cdKey);
      entry.notes = `${entry.notes} | POTENTIAL DUPLICATE - verify manually`;
    }
  }

  if (newEntries.length > 0) {
    appendCsv('review-queue.csv', newEntries as any);
    console.log(`  ✅ Added ${newEntries.length} entries to review queue`);
  } else {
    console.log('  No new entries to add');
  }

  console.log(`  📊 ${dupes} duplicates skipped, ${potentialDupes} potential duplicates flagged`);
  console.log(
    `  Budget after run: ${budget.searches_used}/${budget.monthly_cap} (${budget.monthly_cap - budget.searches_used} remaining).`
  );
  emitResult(newEntries.length, dupes, potentialDupes);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
