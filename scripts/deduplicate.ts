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
  reviewQueue: ReviewEntry[]
): DedupResult {
  // Exact URL match in layoffs.csv
  if (candidate.source_link) {
    const urlMatch = existing.find(
      (e) => e.source_link?.toLowerCase() === candidate.source_link!.toLowerCase()
    );
    if (urlMatch) return 'duplicate';

    const queueMatch = reviewQueue.find(
      (e) => e.source_link?.toLowerCase() === candidate.source_link!.toLowerCase()
    );
    if (queueMatch) return 'duplicate';
  }

  // Title fingerprint match — catches the same Google News article re-fetched under a
  // different wrapper URL on a subsequent run (fingerprint stored as [gn:...] in notes)
  const candidateFp = extractGnFingerprint(candidate.notes || '');
  if (candidateFp) {
    const fpMatch = reviewQueue.find(
      (e) => extractGnFingerprint(e.notes || '') === candidateFp
    );
    if (fpMatch) return 'duplicate';
  }

  // Fuzzy: normalized company + month match
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
