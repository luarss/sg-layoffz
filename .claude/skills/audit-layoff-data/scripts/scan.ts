// Data-integrity scan for the sg-layoffz datasets.
//
// Run from the repo root:  npx tsx .claude/skills/audit-layoff-data/scripts/scan.ts
// Exit code is non-zero if any malformed (glued) row is found, so it can gate CI.

import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { companyKey } from '../../../../scripts/normalize';
import { DOUBLE_COUNT_REVIEW_WINDOW_DAYS } from '../../../../scripts/same-event';
import { eventPairKey, readDistinctEventPairs } from '../../../../scripts/validate';
import { daysBetween } from '../../../../src/lib/dates';

const FILES = ['layoffs.csv', 'rejected.csv'];
const FIRST_DATA_LINE = 2;
const MIN_CLUSTER_ROWS = 3;

interface ScanRow {
  line: number;
  company: string;
  date: string;
  status: string;
  eventId: string;
}

interface EventSummary {
  eventId: string;
  rows: number;
  firstDate: string;
  lastDate: string;
  statuses: Set<string>;
}

function dataPath(file: string): string {
  return path.join(process.cwd(), 'data', file);
}

function readRaw(file: string): string | null {
  const full = dataPath(file);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf-8').replace(/\r\n?/g, '\n');
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}

// The expected field count is derived from each file's own header row, not a
// hardcoded constant — the CSV schema has grown before (8 → 11 columns) and a
// stale hardcoded count made this scan report every row as malformed.
function reportMalformedRows(file: string, raw: string): boolean {
  const rows = Papa.parse<string[]>(raw, { skipEmptyLines: true }).data;
  if (rows.length === 0) return false;
  const expectedFields = rows[0].length;
  const malformed = rows
    .slice(1)
    .map((r, i) => ({ line: i + FIRST_DATA_LINE, n: r.length, first: String(r[0]).slice(0, 50) }))
    .filter((r) => r.n !== expectedFields);
  if (malformed.length === 0) {
    console.log(`\n✓ ${file}: all rows have ${expectedFields} fields`);
    return false;
  }
  console.error(`\n❌ ${file}: ${malformed.length} malformed row(s) (expected ${expectedFields} fields):`);
  for (const m of malformed) console.error(`   line ${m.line}: ${m.n} fields | ${m.first}`);
  return true;
}

function parseScanRows(raw: string): ScanRow[] {
  return Papa.parse<Record<string, string>>(raw, { header: true, skipEmptyLines: true }).data.map((r, i) => ({
    line: i + FIRST_DATA_LINE,
    company: r.company ?? '',
    date: r.date_announced ?? '',
    status: r.status ?? '',
    eventId: (r.event_id ?? '').trim() || `(no event_id, line ${i + FIRST_DATA_LINE})`,
  }));
}

function summarizeEvents(rows: ScanRow[]): EventSummary[] {
  return [...groupBy(rows, (r) => r.eventId)].map(([eventId, items]) => {
    const dates = items.map((r) => r.date).sort();
    return {
      eventId,
      rows: items.length,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      statuses: new Set(items.map((r) => r.status)),
    };
  });
}

function describeEvent(event: EventSummary): string {
  const range = event.firstDate === event.lastDate ? event.firstDate : `${event.firstDate}..${event.lastDate}`;
  return `${event.eventId} (${event.rows} row${event.rows === 1 ? '' : 's'}, ${range}, ${[...event.statuses].join('/')})`;
}

function gapDays(a: EventSummary, b: EventSummary): number {
  const [earlier, later] = a.firstDate <= b.firstDate ? [a, b] : [b, a];
  if (later.firstDate <= earlier.lastDate) return 0;
  return Math.round(daysBetween(earlier.lastDate, later.firstDate));
}

function nearEventPairs(events: EventSummary[]): { key: string; gap: number }[] {
  const pairs: { key: string; gap: number }[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const gap = gapDays(events[i], events[j]);
      if (gap <= DOUBLE_COUNT_REVIEW_WINDOW_DAYS) pairs.push({ key: eventPairKey(events[i].eventId, events[j].eventId), gap });
    }
  }
  return pairs;
}

function reportSameDateAcrossEvents(rows: ScanRow[]): void {
  console.log('\n=== Same company+date split across different event_ids ===');
  const groups = [...groupBy(rows, (r) => `${companyKey(r.company)}|${r.date}`)].filter(
    ([, items]) => new Set(items.map((r) => r.eventId)).size > 1
  );
  if (groups.length === 0) console.log('  none');
  for (const [key, items] of groups) {
    const ids = [...new Set(items.map((r) => r.eventId))].join(', ');
    console.log(`  ${key}: lines ${items.map((r) => r.line).join(', ')} -> event_ids ${ids}`);
  }
}

interface CompanyCluster {
  company: string;
  events: EventSummary[];
  near: { key: string; gap: number }[];
  open: number;
}

function toCluster(company: string, events: EventSummary[], distinctPairs: Set<string>): CompanyCluster {
  events.sort((a, b) => a.firstDate.localeCompare(b.firstDate));
  const near = nearEventPairs(events);
  return { company, events, near, open: near.filter((p) => !distinctPairs.has(p.key)).length };
}

function reportMultiEventCompanies(rows: ScanRow[], distinctPairs: Set<string>): void {
  console.log(
    `\n=== Companies with ${MIN_CLUSTER_ROWS}+ rows split across 2+ event_ids (manual double-count review) ===`
  );
  const clusters = [...groupBy(rows, (r) => companyKey(r.company))]
    .filter(([, items]) => items.length >= MIN_CLUSTER_ROWS)
    .map(([company, items]) => toCluster(company, summarizeEvents(items), distinctPairs))
    .filter((c) => c.events.length > 1)
    .sort((a, b) => b.open - a.open || b.events.length - a.events.length);
  if (clusters.length === 0) console.log('  none');
  for (const { company, events, near, open } of clusters) {
    console.log(
      `  ${company}: ${events.length} event_ids, ${near.length} pair(s) within ${DOUBLE_COUNT_REVIEW_WINDOW_DAYS}d, ${near.length - open} judged distinct`
    );
    for (const event of events) console.log(`    - ${describeEvent(event)}`);
    for (const pair of near) {
      const state = distinctPairs.has(pair.key) ? '✓ distinct' : '? review  ';
      console.log(`    ${state} ${pair.key} (${pair.gap}d gap)`);
    }
  }
}

function reportDistinctEventsFile(rows: ScanRow[], distinctPairs: Set<string>): void {
  console.log('\n=== data/distinct-events.csv ===');
  if (!fs.existsSync(dataPath('distinct-events.csv'))) {
    console.log('  missing — no event pairs are suppressed');
    return;
  }
  const known = new Set(rows.map((r) => r.eventId));
  const stale = [...distinctPairs].filter((pair) => pair.split(' + ').some((id) => !known.has(id)));
  console.log(`  ${distinctPairs.size} pair(s) suppressed, ${stale.length} referencing unknown event_ids`);
  for (const pair of stale) console.log(`    stale: ${pair}`);
}

function main(): number {
  let hadError = false;
  for (const file of FILES) {
    const raw = readRaw(file);
    if (raw !== null && reportMalformedRows(file, raw)) hadError = true;
  }

  const layoffsRaw = readRaw('layoffs.csv');
  if (layoffsRaw === null) return hadError ? 1 : 0;
  const rows = parseScanRows(layoffsRaw);
  const distinctPairs = readDistinctEventPairs();

  reportSameDateAcrossEvents(rows);
  reportMultiEventCompanies(rows, distinctPairs);
  reportDistinctEventsFile(rows, distinctPairs);
  return hadError ? 1 : 0;
}

process.exitCode = main();
