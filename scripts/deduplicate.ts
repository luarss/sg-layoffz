import { LayoffEntry, ReviewEntry } from '../src/lib/types';
import { normalizeCompany } from './normalize';
import { normalizeUrl } from './url-normalize';

export type DedupResult = 'new' | 'duplicate' | 'potential-duplicate';

export function extractGnFingerprint(notes: string): string | null {
  const m = notes?.match(/\[gn:([^\]]+)\]/);
  return m ? m[1] : null;
}

export function isDuplicate(
  candidate: { source_link?: string; company?: string; date_announced?: string; notes?: string },
  existing: LayoffEntry[],
  reviewQueue: ReviewEntry[],
  rejected: LayoffEntry[] = []
): DedupResult {
  // Normalized URL match in layoffs.csv, review queue, or rejected.csv. Normalizing
  // strips utm/tracking params, trailing slashes, scheme, www, AMP variants, and the
  // Wayback wrapper so re-fetches of the same article under a cosmetically different
  // URL are still caught. Rejected articles should not return to the queue on a
  // later scrape. Build each side's normalized-URL set once per call rather than
  // re-normalizing every row on every `.find` — rejected.csv alone runs 3000+ rows.
  if (candidate.source_link) {
    const candidateUrl = normalizeUrl(candidate.source_link);
    if (candidateUrl) {
      const existingUrls = new Set(existing.map((e) => normalizeUrl(e.source_link || '')));
      if (existingUrls.has(candidateUrl)) return 'duplicate';

      const queueUrls = new Set(reviewQueue.map((e) => normalizeUrl(e.source_link || '')));
      if (queueUrls.has(candidateUrl)) return 'duplicate';

      const rejectedUrls = new Set(rejected.map((e) => normalizeUrl(e.source_link || '')));
      if (rejectedUrls.has(candidateUrl)) return 'duplicate';
    }
  }

  // Title fingerprint match — catches the same Google News article re-fetched under a
  // different wrapper URL on a subsequent run (fingerprint stored as [gn:...] in notes).
  // Check the queue AND rejected.csv so rejected articles don't re-surface.
  const candidateFp = extractGnFingerprint(candidate.notes || '');
  if (candidateFp) {
    const fpMatch = reviewQueue.find(
      (e) => extractGnFingerprint(e.notes || '') === candidateFp
    );
    if (fpMatch) return 'duplicate';

    const fpRejected = rejected.find(
      (e) => extractGnFingerprint(e.notes || '') === candidateFp
    );
    if (fpRejected) return 'duplicate';
  }

  // Google News entries: same company + exact date in layoffs.csv, the review
  // queue, or rejected.csv is a duplicate, even if the [gn:...] fingerprint was
  // lost from the earlier entry.
  if (candidate.source_link?.includes('news.google.com') && candidate.company && candidate.date_announced) {
    const normalizedCandidate = normalizeCompany(candidate.company).toLowerCase();
    const allEntries = [...existing, ...reviewQueue, ...rejected];
    const match = allEntries.find((e) => {
      if (!e.company || !e.date_announced) return false;
      return (
        normalizeCompany(e.company).toLowerCase() === normalizedCandidate &&
        e.date_announced === candidate.date_announced
      );
    });
    if (match) return 'duplicate';
  }

  // Fuzzy: normalized company + month match.
  // Only flag against layoffs.csv + review queue (already-tracked events);
  // rejected entries here are noisy commentary, so we don't want to flag every
  // legitimate company-month coincidence as a potential dupe.
  if (candidate.company && candidate.date_announced) {
    const normalizedCandidate = normalizeCompany(candidate.company).toLowerCase();
    const candidateMonth = candidate.date_announced.slice(0, 7); // YYYY-MM

    const all = [...existing, ...reviewQueue];
    for (const entry of all) {
      const normalizedEntry = normalizeCompany(entry.company).toLowerCase();
      const entryMonth = entry.date_announced?.slice(0, 7);

      if (normalizedCandidate === normalizedEntry && candidateMonth === entryMonth) {
        return 'potential-duplicate';
      }
    }
  }

  return 'new';
}
