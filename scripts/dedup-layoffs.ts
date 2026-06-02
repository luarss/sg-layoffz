// Deduplicates data/layoffs.csv by grouping rows on normalizeCompany+date_announced.
// Within each duplicate group, keeps the highest-scoring row using a simple heuristic:
//   +3 confirmed status
//   +2 jobs_cut present
//   +1 pct_workforce present
//   +2 source_link is a Wayback Machine URL
//   +1 source_link is not a Google News RSS wrapper
// Tie-break: first occurrence wins (stable sort).

import { readCsv, writeCsv } from '../src/lib/csv';
import { normalizeCompany } from './normalize';
import { LayoffEntry } from '../src/lib/types';

function score(entry: LayoffEntry): number {
  let s = 0;
  if (entry.status === 'confirmed') s += 3;
  if (entry.jobs_cut != null && entry.jobs_cut !== 0) s += 2;
  if (entry.pct_workforce != null && entry.pct_workforce !== 0) s += 1;
  if (entry.source_link?.includes('web.archive.org')) s += 2;
  if (entry.source_link && !entry.source_link.includes('news.google.com')) s += 1;
  return s;
}

function groupKey(entry: LayoffEntry): string {
  return `${normalizeCompany(entry.company || '').toLowerCase()}|${entry.date_announced || ''}`;
}

const entries = readCsv('layoffs.csv');

const groups = new Map<string, LayoffEntry[]>();
for (const entry of entries) {
  const key = groupKey(entry);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(entry);
}

const kept: LayoffEntry[] = [];
const removed: string[] = [];

for (const [key, group] of groups) {
  if (group.length === 1) {
    kept.push(group[0]);
    continue;
  }

  const sorted = [...group].sort((a, b) => score(b) - score(a));
  kept.push(sorted[0]);

  const [, date] = key.split('|');
  removed.push(`${sorted[0].company} ${date} (kept 1 of ${group.length})`);
  for (const dup of sorted.slice(1)) {
    console.log(`  removed: ${dup.company} ${dup.date_announced} — ${dup.source_link}`);
  }
}

if (removed.length === 0) {
  console.log('No duplicates found.');
  process.exit(0);
}

writeCsv('layoffs.csv', kept);

console.log(`\nRemoved ${entries.length - kept.length} duplicate rows:`);
for (const r of removed) console.log(` • ${r}`);
console.log(`\nlayoffs.csv: ${entries.length} → ${kept.length} rows`);
