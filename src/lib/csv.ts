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
