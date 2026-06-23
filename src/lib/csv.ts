import fs from 'node:fs';
import Papa from 'papaparse';
import { LayoffEntry, CSV_HEADERS } from './types';

function csvPath(filename: string): string {
  return `${process.cwd()}/data/${filename}`;
}

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
    dynamicTyping: true,
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
