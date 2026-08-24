import fs from 'node:fs';
import Papa from 'papaparse';
import { LayoffEntry, CSV_HEADERS } from './types';

function csvPath(filename: string): string {
  return `${process.cwd()}/data/${filename}`;
}

// Only these columns are numeric. Restricting PapaParse's dynamicTyping to them keeps
// every other column a string — otherwise an all-digits value in a string column (e.g.
// a company/title that is purely numeric) gets silently cast to a number, and later
// string ops like `entry.company.slice(...)` throw at runtime.
const NUMERIC_COLUMNS = {
  jobs_cut_sg: true,
  jobs_cut_global: true,
  pct_workforce: true,
} as const;

export function readCsv(filename: string): LayoffEntry[] {
  const filePath = csvPath(filename);
  if (!fs.existsSync(filePath)) return [];

  // Normalize line endings before parsing. A file with mixed CRLF/LF endings makes
  // PapaParse auto-detect "\r\n" as the delimiter and silently merge the LF-only
  // lines into their neighbours' fields (dropping rows). Collapsing everything to LF
  // first makes the parse robust regardless of how the file was written or edited.
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');
  const parsed = Papa.parse<LayoffEntry>(raw, {
    header: true,
    dynamicTyping: NUMERIC_COLUMNS,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors);
  }

  return parsed.data;
}

function cleanRow(row: string): string {
  return row.replace(/\r/g, '');
}

// Ensure an existing file ends with a newline before we append to it. Without this,
// a file whose last row lacks a trailing "\n" would glue the next appended row's first
// field onto the previous row's last field (e.g. status "rumored" + company "Kee Wah
// Bakery" → "rumoredKee Wah Bakery"), corrupting both rows. Safe to call on a missing
// or empty file (no-op in those cases).
export function ensureTrailingNewline(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const fd = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return;
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    if (buf[0] !== 0x0a) fs.appendFileSync(filePath, '\n');
  } finally {
    fs.closeSync(fd);
  }
}

export function appendCsv(filename: string, entries: LayoffEntry[]): void {
  const filePath = csvPath(filename);
  const fileExists = fs.existsSync(filePath);

  if (entries.length === 0) return;

  const rows = cleanRow(
    Papa.unparse(
      entries.map((e) => CSV_HEADERS.map((h) => (e as any)[h] ?? ''))
    )
  );

  if (fileExists) {
    ensureTrailingNewline(filePath);
    fs.appendFileSync(filePath, rows + '\n');
  } else {
    fs.writeFileSync(filePath, (CSV_HEADERS as string[]).join(',') + '\n');
    fs.appendFileSync(filePath, rows + '\n');
  }
}

export function writeCsv(filename: string, entries: LayoffEntry[]): void {
  const filePath = csvPath(filename);
  const csv = cleanRow(
    Papa.unparse(
      {
        fields: CSV_HEADERS as string[],
        data: entries.map((e) => CSV_HEADERS.map((h) => (e as any)[h] ?? '')),
      },
      { newline: '\n' }
    )
  );

  fs.writeFileSync(filePath, csv + '\n');
}

// Column-preserving read/write pair, used by callers that patch layoffs.csv in place
// (e.g. apply-rumor-results.ts) and must NOT silently drop columns the CSV schema
// gained in a parallel change. Unlike readCsv/writeCsv — which project rows onto the
// fixed CSV_HEADERS — these keep whatever columns the file actually has.
export type CsvRow = Record<string, unknown>;

export function readCsvRaw(filename: string): CsvRow[] {
  const filePath = csvPath(filename);
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');
  const parsed = Papa.parse<CsvRow>(raw, {
    header: true,
    dynamicTyping: NUMERIC_COLUMNS,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors);
  }

  return parsed.data;
}

// Derive the column order for a row set: known CSV_HEADERS first (in their canonical
// order, when present in the data), then any extra columns in first-seen order. This
// keeps the familiar layout while tolerating new columns appended by a parallel change.
export function deriveFields(rows: CsvRow[]): string[] {
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const known = (CSV_HEADERS as string[]).filter((h) => present.has(h));
  const extras = [...present].filter((k) => !(CSV_HEADERS as string[]).includes(k));
  return [...known, ...extras];
}

export function writeCsvRaw(filename: string, rows: CsvRow[], fields?: string[]): void {
  const filePath = csvPath(filename);
  const cols = fields && fields.length > 0 ? fields : deriveFields(rows);
  const csv = cleanRow(
    Papa.unparse(
      {
        fields: cols,
        data: rows.map((r) => cols.map((c) => r[c] ?? '')),
      },
      { newline: '\n' }
    )
  );

  fs.writeFileSync(filePath, csv + '\n');
}
