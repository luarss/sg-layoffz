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

import { readCsvRaw, writeCsvRaw, CsvRow } from '../src/lib/csv';
import { RecheckStatus } from './rumor-recheck';

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

export interface ApplyOutcome {
  rows: CsvRow[];
  patched: number;
  skipped: number;
  unmatched: RecheckResult[];
}

function lookupKey(company: unknown, date: unknown): string {
  return `${String(company ?? '').trim().toLowerCase()}||${String(date ?? '').trim()}`;
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
// (company, date_announced), case-insensitive on company. Extra/unknown columns on each
// row are preserved untouched. Exposed for unit testing.
export function applyResults(rows: CsvRow[], results: RecheckResult[]): ApplyOutcome {
  const index = new Map<string, CsvRow>();
  for (const row of rows) {
    index.set(lookupKey(row.company, row.date_announced), row);
  }

  let patched = 0;
  let skipped = 0;
  const unmatched: RecheckResult[] = [];

  for (const result of results) {
    if (!APPLIED_STATUSES.includes(result.new_status as RecheckStatus)) {
      skipped++;
      continue;
    }
    const row = index.get(lookupKey(result.company, result.date_announced));
    if (!row) {
      unmatched.push(result);
      continue;
    }
    // Change ONLY the status field; append evidence to notes.
    row.status = result.new_status;
    row.notes = appendEvidence(row.notes, result.evidence_url);
    patched++;
  }

  return { rows, patched, skipped, unmatched };
}

function main() {
  const results = readCsvRaw('rumor-recheck-results.csv') as unknown as RecheckResult[];
  if (results.length === 0) {
    console.log('No rumor-recheck results to apply.');
    return;
  }

  const rows = readCsvRaw('layoffs.csv');
  const outcome = applyResults(rows, results);

  writeCsvRaw('layoffs.csv', outcome.rows);

  console.log(`Applied rumor-recheck results to data/layoffs.csv:`);
  console.log(`  patched   : ${outcome.patched}`);
  console.log(`  skipped   : ${outcome.skipped} (still-rumored / no status change)`);
  console.log(`  unmatched : ${outcome.unmatched.length}`);
  for (const u of outcome.unmatched) {
    console.log(`    ! no layoffs.csv row for ${u.company} @ ${u.date_announced}`);
  }
}

// Run only when invoked directly, so applyResults can be imported by tests.
if (process.argv[1] && process.argv[1].endsWith('apply-rumor-results.ts')) {
  main();
}
