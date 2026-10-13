import fs from 'node:fs';
import { DAY_MS, monthOf } from '../src/lib/dates';
import { semanticSearch, SearchHit } from './search';
import { dedupeHits, hitToReviewEntry, ingestCandidates } from './scrape-common';
import { sleep } from '../src/lib/async';

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
  return Math.floor((today - start) / DAY_MS);
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
  return monthOf(new Date());
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

async function main() {
  console.log('🔍 Scraping Exa for Singapore layoff coverage...\n');

  const exaKey = process.env.EXA_API_KEY;
  const tinyfishKey = process.env.TINYFISH_API_KEY;

  const budget = loadBudget();
  const remaining = exaKey ? budget.monthly_cap - budget.searches_used : 0;
  if (exaKey) {
    console.log(
      `  Budget: ${budget.searches_used}/${budget.monthly_cap} used this month (${budget.month}); ${remaining} remaining.`
    );
  }

  // Provider tiers: Exa (primary, paid) → TinyFish (free, keyed) → Keenable
  // (free, keyless). Exa is "unavailable" when there's no key or the monthly
  // budget is spent; because Keenable needs no key the run never skips entirely,
  // it just falls through to the free tiers.
  const exaUnavailable = !exaKey || remaining <= 0;
  if (exaUnavailable) {
    const via = tinyfishKey ? 'TinyFish then Keenable' : 'Keenable';
    console.log(`  Exa unavailable (no key or budget exhausted) — falling back to ${via}.`);
    saveBudget(budget); // persists potential month rollover even when Exa is unused
  }

  const runCap = parseInt(process.env.EXA_RUN_CAP || '', 10) || DEFAULT_RUN_CAP;
  // When Exa drives the run, cap by its remaining budget. When falling back to
  // the free tiers, only the per-run cap applies.
  const allowance = exaUnavailable ? runCap : Math.min(remaining, runCap);
  console.log(`  This run will issue up to ${allowance} search(es).`);

  const today = new Date();
  const endDate = today.toISOString();
  const start = new Date(today);
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const startDate = start.toISOString();
  const QUERIES = buildQueries(today);
  console.log(`  Query plan (${QUERIES.length} candidates, capped at ${allowance}):`);

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

    const useExa = exaKey && budget.searches_used < budget.monthly_cap;
    if (useExa) budget.searches_used++;
    const results = await semanticSearch(query, {
      exaKey: useExa ? exaKey : undefined,
      tinyfishKey,
      numResults: RESULTS_PER_QUERY,
      startPublishedDate: startDate,
      endPublishedDate: endDate,
      maxCharacters: 800,
    });
    if (useExa) saveBudget(budget);

    console.log(`    Found ${results.length} results`);
    allResults.push(...results);
    await sleep(500);
  }

  if (skipped > 0) {
    console.log(`  Skipped ${skipped} query(ies) to stay within budget/run-cap.`);
  }

  const unique = dedupeHits(allResults);
  console.log(`\n  Total unique results: ${unique.length}`);

  const entries = unique.map((hit, i) => hitToReviewEntry(hit, i, { idPrefix: 'exa', notesPrefix: 'From Exa' }));
  ingestCandidates('exa', entries);
  console.log(
    `  Budget after run: ${budget.searches_used}/${budget.monthly_cap} (${budget.monthly_cap - budget.searches_used} remaining).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
