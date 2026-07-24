// Deduplicates data/layoffs.csv by grouping rows on normalizeCompany + date window.
// Entries for the same company within DATE_WINDOW_DAYS of each other are treated as
// the same event (handles day-off reporting lag like "May 20 vs May 21" for Meta).
// The window slides: when a new entry joins a group, anchorDate advances to the new
// entry's date, so a chain May 1 → May 5 → May 9 all merges within a 7-day window.
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

const DATE_WINDOW_DAYS = 7;

function score(entry: LayoffEntry): number {
  let s = 0;
  if (entry.status === 'confirmed') s += 3;
  const jobs = entry.jobs_cut_sg ?? entry.jobs_cut_global;
  if (jobs != null && jobs !== 0) s += 2;
  if (entry.pct_workforce != null && entry.pct_workforce !== 0) s += 1;
  if (entry.source_link?.includes('web.archive.org')) s += 2;
  if (entry.source_link && !entry.source_link.includes('news.google.com')) s += 1;
  return s;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

interface EventGroup {
  anchorDate: string | null;
  entries: LayoffEntry[];
}

const entries = readCsv('layoffs.csv');

// Group by normalized company name, then cluster by date window within each company.
const byCompany = new Map<string, EventGroup[]>();

for (const entry of entries) {
  const compKey = normalizeCompany(entry.company || '').toLowerCase();
  if (!byCompany.has(compKey)) byCompany.set(compKey, []);

  const groups = byCompany.get(compKey)!;
  const d = entry.date_announced || null;

  let matched = false;
  for (const group of groups) {
    if (!d || !group.anchorDate) {
      // Entries without a date only merge with other no-date entries for same company.
      if (!d && !group.anchorDate) {
        group.entries.push(entry);
        matched = true;
        break;
      }
      continue;
    }
    if (daysBetween(d, group.anchorDate) <= DATE_WINDOW_DAYS) {
      group.entries.push(entry);
      if (d > group.anchorDate) group.anchorDate = d;
      matched = true;
      break;
    }
  }

  if (!matched) {
    groups.push({ anchorDate: d, entries: [entry] });
  }
}

const kept: LayoffEntry[] = [];
const removed: string[] = [];

for (const groups of byCompany.values()) {
  for (const { entries: group } of groups) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }

    const sorted = [...group].sort((a, b) => score(b) - score(a));
    kept.push(sorted[0]);

    const dates = group.map((e) => e.date_announced).filter(Boolean).join(', ');
    removed.push(`${sorted[0].company} [${dates}] (kept 1 of ${group.length})`);
    for (const dup of sorted.slice(1)) {
      console.log(`  removed: ${dup.company} ${dup.date_announced} — ${dup.source_link}`);
    }
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
