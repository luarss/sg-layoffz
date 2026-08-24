import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCsv, readCsvRaw } from '../src/lib/csv';
import { CSV_HEADERS } from '../src/lib/types';

// readCsv resolves paths against process.cwd()/data, so exercise it from a temp cwd.
const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

function withCsvFixture(filename: string, contents: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-fixture-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', filename), contents);
  process.chdir(dir);
}

// Regression: PapaParse's blanket dynamicTyping cast any all-digits field to a number,
// so a purely-numeric company/title became a number and later `entry.company.slice(...)`
// threw "entry.company.slice is not a function", crashing the triage job.
describe('readCsv — string columns stay strings', () => {
  it('keeps an all-digits company as a string', () => {
    const header = CSV_HEADERS.join(',');
    const row = ['2359', '2026-08-23', '2026-08-23', '', '', '', 'Tech', 'https://example.com', 'note', 'rumored', 'evt-1'];
    withCsvFixture('review-queue.csv', `${header}\n${row.join(',')}\n`);

    const [entry] = readCsv('review-queue.csv');
    expect(typeof entry.company).toBe('string');
    expect(entry.company).toBe('2359');
    expect(() => (entry.company as string).slice(0, 50)).not.toThrow();
  });

  it('still parses numeric columns as numbers', () => {
    const header = CSV_HEADERS.join(',');
    const row = ['Acme', '2026-08-23', '2026-08-23', '120', '500', '', 'Tech', 'https://example.com', 'note', 'confirmed', 'evt-2'];
    withCsvFixture('review-queue.csv', `${header}\n${row.join(',')}\n`);

    const [entry] = readCsv('review-queue.csv');
    expect(entry.jobs_cut_sg).toBe(120);
    expect(entry.jobs_cut_global).toBe(500);
  });

  it('readCsvRaw also keeps an all-digits value as a string', () => {
    withCsvFixture('raw.csv', 'company,jobs_cut_sg\n2359,120\n');
    const [row] = readCsvRaw('raw.csv');
    expect(typeof row.company).toBe('string');
    expect(row.jobs_cut_sg).toBe(120);
  });
});
