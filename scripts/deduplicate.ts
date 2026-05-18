import { LayoffEntry, ReviewEntry } from '../src/lib/types';
import { normalizeCompany } from './normalize';

export type DedupResult = 'new' | 'duplicate' | 'potential-duplicate';

function extractGnFingerprint(notes: string): string | null {
  const m = notes?.match(/\[gn:([^\]]+)\]/);
  return m ? m[1] : null;
}

export function isDuplicate(
  candidate: { source_link?: string; company?: string; date_announced?: string; notes?: string },
  existing: LayoffEntry[],
  reviewQueue: ReviewEntry[],
  rejected: LayoffEntry[] = []
): DedupResult {
  // Exact URL match in layoffs.csv, review queue, or rejected.csv.
  // Rejected articles should not return to the queue on a later scrape.
  if (candidate.source_link) {
    const candidateUrl = candidate.source_link.toLowerCase();
    const urlMatch = existing.find((e) => e.source_link?.toLowerCase() === candidateUrl);
    if (urlMatch) return 'duplicate';

    const queueMatch = reviewQueue.find((e) => e.source_link?.toLowerCase() === candidateUrl);
    if (queueMatch) return 'duplicate';

    const rejectedMatch = rejected.find((e) => e.source_link?.toLowerCase() === candidateUrl);
    if (rejectedMatch) return 'duplicate';
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
