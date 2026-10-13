import { LayoffEntry, ReviewEntry } from '../src/lib/types';
import { companyKey, companyMonthKey } from './normalize';
import { normalizeUrl } from './url-normalize';

export type DedupResult = 'new' | 'duplicate' | 'potential-duplicate';

export interface DedupCandidate {
  source_link?: string;
  company?: string;
  date_announced?: string;
  notes?: string;
}

export interface DedupIndex {
  urls: Set<string>;
  fingerprints: Set<string>;
  companyDates: Set<string>;
  companyMonths: Set<string>;
}

type DedupRow = Pick<LayoffEntry, 'source_link' | 'company' | 'date_announced' | 'notes'>;

export function extractGnFingerprint(notes: string): string | null {
  const m = notes?.match(/\[gn:([^\]]+)\]/);
  return m ? m[1] : null;
}

export function companyDateKey(company: string, date: string): string {
  return `${companyKey(company)}||${date}`;
}

function collectUrls(rows: DedupRow[]): Set<string> {
  return new Set(rows.map((row) => normalizeUrl(row.source_link || '')));
}

function collectFingerprints(rows: DedupRow[]): Set<string> {
  const fingerprints = new Set<string>();
  for (const row of rows) {
    const fingerprint = extractGnFingerprint(row.notes || '');
    if (fingerprint) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

function collectCompanyDates(rows: DedupRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.company && row.date_announced) keys.add(companyDateKey(row.company, row.date_announced));
  }
  return keys;
}

function collectCompanyMonths(rows: DedupRow[]): Set<string> {
  return new Set(rows.map((row) => companyMonthKey(row.company || '', row.date_announced || '')));
}

export function buildDedupIndex(
  existing: LayoffEntry[],
  reviewQueue: ReviewEntry[],
  rejected: LayoffEntry[] = []
): DedupIndex {
  return {
    urls: collectUrls([...existing, ...reviewQueue, ...rejected]),
    fingerprints: collectFingerprints([...reviewQueue, ...rejected]),
    companyDates: collectCompanyDates([...existing, ...reviewQueue, ...rejected]),
    companyMonths: collectCompanyMonths([...existing, ...reviewQueue]),
  };
}

export function isDuplicateIndexed(candidate: DedupCandidate, index: DedupIndex): DedupResult {
  const candidateUrl = candidate.source_link ? normalizeUrl(candidate.source_link) : '';
  if (candidateUrl && index.urls.has(candidateUrl)) return 'duplicate';

  const candidateFingerprint = extractGnFingerprint(candidate.notes || '');
  if (candidateFingerprint && index.fingerprints.has(candidateFingerprint)) return 'duplicate';

  const { company, date_announced: date } = candidate;
  if (!company || !date) return 'new';

  const isGoogleNews = candidate.source_link?.includes('news.google.com');
  if (isGoogleNews && index.companyDates.has(companyDateKey(company, date))) return 'duplicate';

  if (index.companyMonths.has(companyMonthKey(company, date))) return 'potential-duplicate';

  return 'new';
}

export function isDuplicate(
  candidate: DedupCandidate,
  existing: LayoffEntry[],
  reviewQueue: ReviewEntry[],
  rejected: LayoffEntry[] = []
): DedupResult {
  return isDuplicateIndexed(candidate, buildDedupIndex(existing, reviewQueue, rejected));
}
