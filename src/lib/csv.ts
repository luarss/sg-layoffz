import fs from 'node:fs';
import Papa from 'papaparse';
import { LayoffEntry, CSV_HEADERS } from './types';

function csvPath(filename: string): string {
  return `${process.cwd()}/data/${filename}`;
}

export function readCsv(filename: string): LayoffEntry[] {
  const filePath = csvPath(filename);
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8');
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

export function appendCsv(filename: string, entries: LayoffEntry[]): void {
  const filePath = csvPath(filename);
  const fileExists = fs.existsSync(filePath);

  if (entries.length === 0) return;

  const csv = Papa.unparse({
    fields: CSV_HEADERS as string[],
    data: entries.map((e) => CSV_HEADERS.map((h) => e[h] ?? '')),
  });

  if (fileExists) {
    fs.appendFileSync(filePath, '\n' + csv + '\n');
  } else {
    fs.writeFileSync(filePath, Papa.unparse({ fields: CSV_HEADERS as string[], data: [] }) + '\n');
    fs.appendFileSync(filePath, csv + '\n');
  }
}

export function writeCsv(filename: string, entries: LayoffEntry[]): void {
  const filePath = csvPath(filename);
  const csv = Papa.unparse({
    fields: CSV_HEADERS as string[],
    data: [
      ...(CSV_HEADERS as string[]),
      ...entries.map((e) => CSV_HEADERS.map((h) => e[h] ?? '')),
    ],
  });

  fs.writeFileSync(filePath, csv + '\n');
}
