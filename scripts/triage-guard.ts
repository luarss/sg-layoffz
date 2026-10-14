import { LayoffEntry } from '../src/lib/types';
import { analyzeDataset, newWarnings, readDistinctEventPairs, IntegrityWarning } from './validate';

export type TriageTarget = 'layoffs' | 'rejected';

export interface TriageCandidate {
  target: TriageTarget;
  row: LayoffEntry;
}

export interface HeldBackCandidate {
  candidate: TriageCandidate;
  warnings: IntegrityWarning[];
}

export interface ScreenedBatch {
  accepted: LayoffEntry[];
  rejected: LayoffEntry[];
  heldBack: HeldBackCandidate[];
}

export type DatasetAnalyzer = (layoffs: LayoffEntry[], rejected: LayoffEntry[]) => IntegrityWarning[];

function rowsFor(candidates: TriageCandidate[], target: TriageTarget): LayoffEntry[] {
  return candidates.filter((c) => c.target === target).map((c) => c.row);
}

function analyzeWith(
  analyze: DatasetAnalyzer,
  layoffs: LayoffEntry[],
  rejected: LayoffEntry[],
  candidates: TriageCandidate[]
): IntegrityWarning[] {
  return analyze([...layoffs, ...rowsFor(candidates, 'layoffs')], [...rejected, ...rowsFor(candidates, 'rejected')]);
}

export function screenTriageBatch(
  existingLayoffs: LayoffEntry[],
  existingRejected: LayoffEntry[],
  candidates: TriageCandidate[],
  analyze: DatasetAnalyzer
): ScreenedBatch {
  const baseline = analyze(existingLayoffs, existingRejected);
  const kept: TriageCandidate[] = [];
  const heldBack: HeldBackCandidate[] = [];

  const wholeBatch = analyzeWith(analyze, existingLayoffs, existingRejected, candidates);
  if (newWarnings(wholeBatch, baseline).length === 0) {
    kept.push(...candidates);
  } else {
    let current = baseline;
    for (const candidate of candidates) {
      const trial = analyzeWith(analyze, existingLayoffs, existingRejected, [...kept, candidate]);
      const added = newWarnings(trial, current);
      if (added.length > 0) {
        heldBack.push({ candidate, warnings: added });
        continue;
      }
      kept.push(candidate);
      current = trial;
    }
  }

  return { accepted: rowsFor(kept, 'layoffs'), rejected: rowsFor(kept, 'rejected'), heldBack };
}

export function datasetAnalyzer(): DatasetAnalyzer {
  const distinctPairs = readDistinctEventPairs();
  return (layoffs, rejected) => {
    const analysis = analyzeDataset(layoffs, rejected, distinctPairs);
    return [...analysis.hardIntegrityErrors, ...analysis.warnings];
  };
}
