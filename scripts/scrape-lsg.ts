import { ReviewEntry } from '../src/lib/types';
import { normalizeCompany, normalizeIndustry, parseDate } from './normalize';
import { todayIso } from '../src/lib/dates';
import { ingestCandidates, printScrapeResult } from './scrape-common';

// layoffsg.com is a Base44 no-code app. Every layoff row lives in the public,
// unauthenticated `LayoffEvent` entity — no key, no pagination cursor needed for
// a dataset this small. We pull it as one more candidate source and drop rows
// into the SAME review queue every other scraper feeds, so triage/dedup decide
// what actually lands in layoffs.csv. Nothing here writes to layoffs.csv directly.
const APP_ID = '6a13b3459406db4d744db0f2';
const API_URL = `https://base44.app/api/apps/${APP_ID}/entities/LayoffEvent?limit=10000`;

// Shape of a Base44 LayoffEvent record (only the fields we consume).
interface LayoffEvent {
  id: string;
  company?: string;
  announcement_date?: string;
  created_date?: string;
  sg_employees_affected?: number | null;
  is_exact_count?: boolean;
  industry?: string;
  source_name?: string;
  source_url?: string;
  notes?: string;
}

// Their industry values are snake_case (real_estate, banking_finance). Swapping
// underscores for spaces lets normalizeIndustry's existing map/fuzzy logic map
// them onto our INDUSTRIES buckets (real_estate -> Real Estate, etc.).
function mapIndustry(raw: string | undefined): string {
  if (!raw) return 'Other';
  return normalizeIndustry(raw.replace(/_/g, ' '));
}

function eventToReviewEntry(ev: LayoffEvent, index: number): ReviewEntry {
  const announced = parseDate(ev.announcement_date || '') || '';
  const reported =
    announced || parseDate(ev.created_date || '') || todayIso();

  // Their source_url is frequently blank, so fall back to a stable per-event URL.
  // A stable link matters: isDuplicate keys on exact source_link, so on re-runs
  // the same event dedups by URL instead of re-entering the queue.
  const sourceLink = ev.source_url?.trim() || `https://layoffsg.com/feed?event=${ev.id}`;

  const affected =
    typeof ev.sg_employees_affected === 'number'
      ? Math.round(ev.sg_employees_affected)
      : null;

  const provenance = [
    ev.source_name ? `via ${ev.source_name}` : null,
    ev.is_exact_count === false ? 'estimate' : ev.is_exact_count ? 'exact count' : null,
    ev.notes?.trim() || null,
  ]
    .filter(Boolean)
    .join('; ');

  // [lsg:<id>] is our fingerprint for this source — lets a human (and future
  // dedup passes) trace a queue row back to the exact layoffsg.com record.
  return {
    review_id: `layoffsg-${ev.id}-${index}`,
    company: normalizeCompany(ev.company || ''),
    date_announced: announced || reported,
    date_reported: reported,
    // Their count is already Singapore-scoped (sg_employees_affected).
    jobs_cut_sg: affected,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: mapIndustry(ev.industry),
    source_link: sourceLink,
    notes: `From layoffsg.com${provenance ? ` (${provenance})` : ''} [lsg:${ev.id}]`,
    // Enter as rumored like every scraped candidate; triage promotes/rejects.
    status: 'rumored',
    event_id: '',
    candidate_urls: sourceLink,
    snippet: (ev.notes?.trim() || provenance).slice(0, 300),
  };
}

function uniqueEventEntries(events: LayoffEvent[]): { entries: ReviewEntry[]; skipped: number } {
  const seenIds = new Set<string>();
  const entries: ReviewEntry[] = [];
  let skipped = 0;

  events.forEach((ev, i) => {
    if (!ev.id || seenIds.has(ev.id)) {
      skipped++;
      return;
    }
    seenIds.add(ev.id);

    const entry = eventToReviewEntry(ev, i);
    if (!entry.company) {
      skipped++;
      return;
    }
    entries.push(entry);
  });

  return { entries, skipped };
}

async function main() {
  console.log('🔍 Ingesting layoffsg.com (Base44 public LayoffEvent API)...\n');

  let events: LayoffEvent[];
  try {
    const res = await fetch(API_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    events = (await res.json()) as LayoffEvent[];
  } catch (err) {
    console.error(`  Failed to fetch layoffsg.com: ${(err as Error).message}`);
    printScrapeResult('layoffsg', { newEntries: 0, duplicates: 0, potentialDupes: 0 });
    return;
  }

  console.log(`  Fetched ${events.length} layoff events.`);

  const { entries, skipped } = uniqueEventEntries(events);
  ingestCandidates('layoffsg', entries, skipped);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
