import fs from 'node:fs';
import { readCsv, appendCsv } from '../src/lib/csv';
import { ReviewEntry } from '../src/lib/types';
import { normalizeCompany, parseDate, extractJobsFromText } from './normalize';
import { isDuplicate } from './deduplicate';

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

// Job boards and recruiting sites excluded at the Exa API level via excludeDomains.
const EXCLUDED_DOMAINS = [
  'accaglobal.com',
  'alchemygts.com',
  'frazerjones.com',
  'gaapweb.com',
  'glassdoor.com',
  'hireza.wuaze.com',
  'indeed.com',
  'interimsearch.com',
  'jobsdb.com',
  'linkedin.com',
  'mycareersfuture.gov.sg',
  'nicollcurtin.com',
  'seek.com',
  'totallylegal.com',
];

const BUDGET_PATH = `${process.cwd()}/data/exa-budget.json`;

interface ExaResult {
  url: string;
  title?: string;
  publishedDate?: string;
  text?: string;
  author?: string;
}

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

function titleFingerprint(title: string): string {
  return title
    .replace(/ [-–] [^-–\n]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

async function runExaQuery(
  apiKey: string,
  query: string,
  startDate: string,
  endDate: string
): Promise<ExaResult[]> {
  const t0 = Date.now();
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: RESULTS_PER_QUERY,
      type: 'auto',
      startPublishedDate: startDate,
      endPublishedDate: endDate,
      excludeDomains: EXCLUDED_DOMAINS,
      contents: { text: { maxCharacters: 800 } },
    }),
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Exa ${res.status}: ${body.slice(0, 200)} (${elapsed}s)`);
  }
  const data = (await res.json()) as { results?: ExaResult[] };
  console.log(`    [timing] "${query}": ${elapsed}s`);
  return data.results || [];
}

function resultToReviewEntry(r: ExaResult, index: number): ReviewEntry {
  const title = r.title || r.url;
  const text = r.text || '';
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

function emitResult(newEntries: number, dupes: number, potential: number) {
  console.log(
    `SCRAPE_RESULT:source=exa,new_entries=${newEntries},duplicates=${dupes},potential_dupes=${potential}`
  );
}

async function main() {
  console.log('🔍 Scraping Exa for Singapore layoff coverage...\n');

  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    console.log('  EXA_API_KEY not set — skipping Exa scrape.');
    emitResult(0, 0, 0);
    return;
  }

  const budget = loadBudget();
  const remaining = budget.monthly_cap - budget.searches_used;
  console.log(
    `  Budget: ${budget.searches_used}/${budget.monthly_cap} used this month (${budget.month}); ${remaining} remaining.`
  );

  if (remaining <= 0) {
    console.log('  Monthly budget exhausted — skipping Exa scrape.');
    emitResult(0, 0, 0);
    saveBudget(budget); // persists potential month rollover even on no-op
    return;
  }

  const runCap = parseInt(process.env.EXA_RUN_CAP || '', 10) || DEFAULT_RUN_CAP;
  const allowance = Math.min(remaining, runCap);
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

  const allResults: ExaResult[] = [];
  let issued = 0;
  let skipped = 0;

  for (const query of QUERIES) {
    if (issued >= allowance) {
      skipped++;
      continue;
    }
    console.log(`  Query: "${query}"`);
    issued++;
    budget.searches_used++;
    try {
      const results = await runExaQuery(apiKey, query, startDate, endDate);
      console.log(`    Found ${results.length} results`);
      allResults.push(...results);
    } catch (err) {
      console.error(`    Failed: ${(err as Error).message}`);
    }
    // Persist after every call so a crash mid-run doesn't reset the counter.
    saveBudget(budget);
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
