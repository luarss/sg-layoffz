// Apply rumor-recheck decisions to data/layoffs.csv.
//
// Reads data/rumor-recheck-results.csv (produced by rumor-recheck.ts), looks each row
// up in layoffs.csv by (company, date_announced), and — for rows whose verdict changed
// the status — updates ONLY the status field and appends the evidence URL to notes.
// "still-rumored" verdicts are no-ops.
//
// Uses the column-preserving readCsvRaw/writeCsvRaw helpers so this tolerates new
// columns the CSV schema may have gained in a parallel change (we never project rows
// onto a fixed header list, so unknown columns survive round-tripping).
//
// Usage: tsx scripts/apply-rumor-results.ts

import { readCsv, readCsvRaw, writeCsvRaw, CsvRow } from '../src/lib/csv';
import { LayoffEntry } from '../src/lib/types';
import { RecheckStatus } from './rumor-recheck';
import { companyKey } from './normalize';
import { analyzeDataset, newWarnings, readDistinctEventPairs, IntegrityWarning } from './validate';

// The verdicts that actually mutate a row's status. "still-rumored" is intentionally
// excluded — it means "leave the row as-is".
const APPLIED_STATUSES: RecheckStatus[] = ['confirmed', 'denied', 'expired'];

export interface RecheckResult {
  company: string;
  date_announced: string;
  new_status: string;
  evidence_url: string;
  evidence_note?: string;
}

export interface AppliedChange {
  rowIndex: number;
  result: RecheckResult;
  previousStatus: unknown;
  previousNotes: unknown;
}

export interface ApplyOutcome {
  rows: CsvRow[];
  patched: number;
  skipped: number;
  unmatched: RecheckResult[];
  changes: AppliedChange[];
}

export interface HeldBackChange {
  result: RecheckResult;
  warnings: IntegrityWarning[];
}

export type WarningAnalyzer = (rows: CsvRow[]) => IntegrityWarning[];

function lookupKey(company: unknown, date: unknown): string {
  return `${companyKey(String(company ?? ''))}||${String(date ?? '').trim()}`;
}

// Append the evidence URL to a notes string, avoiding a duplicate if it is already there.
function appendEvidence(notes: unknown, url: string): string {
  const base = String(notes ?? '').trim();
  if (!url) return base;
  if (base.includes(url)) return base;
  return base ? `${base} | Evidence: ${url}` : `Evidence: ${url}`;
}

// Pure application logic: given the current layoffs rows and the recheck results,
// return a new row set with statuses patched and evidence appended. Rows are matched by
// (company, date_announced), comparing companies by companyKey. Extra/unknown columns on each
// row are preserved untouched. Exposed for unit testing.
export function applyResults(rows: CsvRow[], results: RecheckResult[]): ApplyOutcome {
  const index = new Map<string, number>();
  rows.forEach((row, rowIndex) => index.set(lookupKey(row.company, row.date_announced), rowIndex));

  let patched = 0;
  let skipped = 0;
  const unmatched: RecheckResult[] = [];
  const changes: AppliedChange[] = [];

  for (const result of results) {
    if (!APPLIED_STATUSES.includes(result.new_status as RecheckStatus)) {
      skipped++;
      continue;
    }
    const rowIndex = index.get(lookupKey(result.company, result.date_announced));
    if (rowIndex === undefined) {
      unmatched.push(result);
      continue;
    }
    const row = rows[rowIndex];
    changes.push({ rowIndex, result, previousStatus: row.status, previousNotes: row.notes });
    // Change ONLY the status field; append evidence to notes.
    row.status = result.new_status;
    row.notes = appendEvidence(row.notes, result.evidence_url);
    patched++;
  }

  return { rows, patched, skipped, unmatched, changes };
}

function changesImplicatedBy(changes: AppliedChange[], warnings: IntegrityWarning[]): AppliedChange[] {
  const flaggedRows = new Set(warnings.flatMap((w) => w.rows));
  return changes.filter((change) => flaggedRows.has(change.rowIndex + 1));
}

export function applyResultsSafely(
  rows: CsvRow[],
  results: RecheckResult[],
  analyze: WarningAnalyzer
): ApplyOutcome & { heldBack: HeldBackChange[] } {
  const baseline = analyze(rows);
  const outcome = applyResults(rows, results);
  const heldBack: HeldBackChange[] = [];
  let active = outcome.changes;

  while (active.length > 0) {
    const added = newWarnings(analyze(rows), baseline);
    const implicated = changesImplicatedBy(active, added);
    if (implicated.length === 0) break;
    for (const change of implicated) {
      rows[change.rowIndex].status = change.previousStatus;
      rows[change.rowIndex].notes = change.previousNotes;
      const rowNumber = change.rowIndex + 1;
      heldBack.push({ result: change.result, warnings: added.filter((w) => w.rows.includes(rowNumber)) });
    }
    active = active.filter((change) => !implicated.includes(change));
  }

  return { ...outcome, patched: active.length, changes: active, heldBack };
}

function datasetWarningAnalyzer(): WarningAnalyzer {
  const rejected = readCsv('rejected.csv');
  const distinctPairs = readDistinctEventPairs();
  return (rows) => {
    const analysis = analyzeDataset(rows as unknown as LayoffEntry[], rejected, distinctPairs);
    return [...analysis.hardIntegrityErrors, ...analysis.warnings];
  };
}

function main() {
  const results = readCsvRaw('rumor-recheck-results.csv') as unknown as RecheckResult[];
  if (results.length === 0) {
    console.log('No rumor-recheck results to apply.');
    return;
  }

  const rows = readCsvRaw('layoffs.csv');
  const outcome = applyResultsSafely(rows, results, datasetWarningAnalyzer());

  writeCsvRaw('layoffs.csv', outcome.rows);

  console.log(`Applied rumor-recheck results to data/layoffs.csv:`);
  console.log(`  patched   : ${outcome.patched}`);
  console.log(`  skipped   : ${outcome.skipped} (still-rumored / no status change)`);
  console.log(`  unmatched : ${outcome.unmatched.length}`);
  for (const u of outcome.unmatched) {
    console.log(`    ! no layoffs.csv row for ${u.company} @ ${u.date_announced}`);
  }
  console.log(`  held back : ${outcome.heldBack.length} (would add integrity warnings)`);
  for (const held of outcome.heldBack) {
    console.log(`    ! kept ${held.result.company} @ ${held.result.date_announced} instead of ${held.result.new_status}:`);
    for (const w of held.warnings) console.log(`        [${w.type}] ${w.message}`);
  }
}

// Run only when invoked directly, so applyResults can be imported by tests.
if (process.argv[1] && process.argv[1].endsWith('apply-rumor-results.ts')) {
  main();
}
