import { readCsv, appendCsv } from '../src/lib/csv';
import { ReviewEntry } from '../src/lib/types';
import { normalizeCompany, parseDate, extractJobsFromText } from './normalize';
import { todayIso } from '../src/lib/dates';
import { buildDedupIndex, companyDateKey, isDuplicateIndexed } from './deduplicate';
import { titleFingerprint, SearchHit } from './search';

export const POTENTIAL_DUPLICATE_NOTE = 'POTENTIAL DUPLICATE - verify manually';

export interface ReviewEntryFormat {
  idPrefix?: string;
  notesPrefix?: string;
}

export interface ScrapeCounts {
  newEntries: number;
  duplicates: number;
  potentialDupes: number;
}

function guessCompany(title: string): string {
  return normalizeCompany(title.split(/cuts?|lays? off|retrench|sheds?/i)[0] || title);
}

function reviewId(idPrefix: string | undefined, idx: number): string {
  const stamp = `${Date.now()}-${idx}`;
  return idPrefix ? `${idPrefix}-${stamp}` : stamp;
}

function fingerprintNote(notesPrefix: string | undefined, title: string): string {
  const tag = `[gn:${titleFingerprint(title)}]`;
  return notesPrefix ? `${notesPrefix} ${tag}` : tag;
}

export function hitToReviewEntry(
  hit: SearchHit,
  idx: number,
  { idPrefix, notesPrefix }: ReviewEntryFormat = {}
): ReviewEntry {
  const title = hit.title || hit.url;
  const snippet = hit.snippet || '';
  const date = parseDate(hit.publishedDate || '') || todayIso();

  return {
    review_id: reviewId(idPrefix, idx),
    company: guessCompany(title),
    date_announced: date,
    date_reported: date,
    jobs_cut_sg: extractJobsFromText(`${title}. ${snippet}`),
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Other',
    source_link: hit.url,
    notes: fingerprintNote(notesPrefix, title),
    status: 'rumored',
    event_id: '',
    candidate_urls: hit.url,
    snippet: snippet.slice(0, 300),
  };
}

export function dedupeHits<T extends Pick<SearchHit, 'title' | 'url'>>(hits: T[]): T[] {
  const seenUrls = new Set<string>();
  const seenFingerprints = new Set<string>();
  return hits.filter((hit) => {
    if (!hit.url || seenUrls.has(hit.url)) return false;
    seenUrls.add(hit.url);
    const fingerprint = titleFingerprint(hit.title || hit.url);
    if (fingerprint && seenFingerprints.has(fingerprint)) return false;
    if (fingerprint) seenFingerprints.add(fingerprint);
    return true;
  });
}

export function printScrapeResult(source: string, counts: ScrapeCounts): void {
  console.log(
    `SCRAPE_RESULT:source=${source},new_entries=${counts.newEntries},duplicates=${counts.duplicates},potential_dupes=${counts.potentialDupes}`
  );
}

function loadDedupIndex() {
  const layoffs = readCsv('layoffs.csv');
  const reviewQueue = readCsv('review-queue.csv') as ReviewEntry[];
  const rejected = readCsv('rejected.csv');
  return buildDedupIndex(layoffs, reviewQueue, rejected);
}

function writeToQueue(entries: ReviewEntry[]): void {
  if (entries.length > 0) {
    appendCsv('review-queue.csv', entries);
    console.log(`  ✅ Added ${entries.length} entries to review queue`);
  } else {
    console.log('  No new entries to add');
  }
}

export function ingestCandidates(
  source: string,
  entries: ReviewEntry[],
  alreadySkipped = 0
): ScrapeCounts {
  const index = loadDedupIndex();
  const accepted: ReviewEntry[] = [];
  const seenCompanyDates = new Set<string>();
  let duplicates = alreadySkipped;
  let potentialDupes = 0;

  for (const entry of entries) {
    const key = companyDateKey(entry.company, entry.date_announced);
    if (seenCompanyDates.has(key)) {
      duplicates++;
      continue;
    }

    const result = isDuplicateIndexed(entry, index);
    if (result === 'duplicate') {
      duplicates++;
      continue;
    }
    if (result === 'potential-duplicate') {
      potentialDupes++;
      entry.notes = entry.notes ? `${entry.notes} | ${POTENTIAL_DUPLICATE_NOTE}` : POTENTIAL_DUPLICATE_NOTE;
    }
    accepted.push(entry);
    seenCompanyDates.add(key);
  }

  writeToQueue(accepted);
  const counts = { newEntries: accepted.length, duplicates, potentialDupes };
  console.log(`  📊 ${duplicates} duplicates skipped, ${potentialDupes} potential duplicates flagged`);
  printScrapeResult(source, counts);
  return counts;
}
