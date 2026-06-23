import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Papa from 'papaparse';
import { validateCsv } from '../scripts/validate';
import { ensureTrailingNewline } from '../src/lib/csv';
import { CSV_HEADERS } from '../src/lib/types';

// Golden-data gate: the committed datasets must have ZERO hard validation errors.
// This is what catches a corrupted row (bad status enum, merged fields, missing
// required field) before it reaches main — the kind of breakage that the unit
// tests on synthetic fixtures cannot see because they never read the real files.
// Integrity *warnings* (possible double-counts, unarchived sources) are allowed.
describe('committed data integrity', () => {
  it('layoffs.csv has no validation errors', () => {
    const { errors } = validateCsv('layoffs.csv');
    expect(errors).toEqual([]);
  });

  it('every row in layoffs.csv and rejected.csv has exactly 8 fields', () => {
    // A missing trailing newline on append glues the next row's first field onto the
    // previous row's last field, producing a row with too many or too few columns.
    // Parse raw (header:false) so a merged row surfaces as a field-count mismatch.
    for (const file of ['layoffs.csv', 'rejected.csv']) {
      const raw = fs
        .readFileSync(path.join(process.cwd(), 'data', file), 'utf-8')
        .replace(/\r\n?/g, '\n');
      const rows = Papa.parse<string[]>(raw, { skipEmptyLines: true }).data;
      const malformed = rows
        .map((r, i) => ({ i: i + 1, n: r.length }))
        .filter((r) => r.n !== CSV_HEADERS.length);
      expect(malformed, `${file} has rows with != ${CSV_HEADERS.length} fields`).toEqual([]);
    }
  });
});

// Regression for the "rumoredKee Wah Bakery" corruption: appending to a file whose
// last row lacks a trailing newline must not glue rows together.
describe('ensureTrailingNewline', () => {
  function tmpFile(contents: string): string {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csv-')), 'f.csv');
    fs.writeFileSync(p, contents);
    return p;
  }

  it('adds a newline when the file does not end in one', () => {
    const p = tmpFile('a,b,c');
    ensureTrailingNewline(p);
    expect(fs.readFileSync(p, 'utf-8')).toBe('a,b,c\n');
  });

  it('leaves a file that already ends in a newline untouched', () => {
    const p = tmpFile('a,b,c\n');
    ensureTrailingNewline(p);
    expect(fs.readFileSync(p, 'utf-8')).toBe('a,b,c\n');
  });

  it('is a no-op on an empty or missing file', () => {
    const p = tmpFile('');
    ensureTrailingNewline(p);
    expect(fs.readFileSync(p, 'utf-8')).toBe('');
    expect(() => ensureTrailingNewline(p + '.nope')).not.toThrow();
  });

  it('prevents row gluing when appending after a newline-less row', () => {
    const p = tmpFile('B For Bagel,2026-06-10,F&B,rumored');
    ensureTrailingNewline(p);
    fs.appendFileSync(p, 'Kee Wah Bakery,2026-04-24,F&B,confirmed\n');
    const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].endsWith('rumored')).toBe(true);
    expect(lines[1].startsWith('Kee Wah Bakery')).toBe(true);
  });
});
