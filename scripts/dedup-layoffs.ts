// Links duplicate data/layoffs.csv rows to a shared event_id instead of deleting them.
//
// Rows are grouped by normalized company name using a sliding 7-day window on
// date_announced (handles day-off reporting lag like "May 20 vs May 21" for Meta).
// The window slides: when a new entry joins a group, anchorDate advances to the new
// entry's date, so a chain May 1 → May 5 → May 9 all merges within a 7-day window.
// Rows anywhere in the file that share an identical normalized source_link are ALSO
// merged into one group, even across different company keys or outside the date
// window — this catches the same article re-scraped under a slightly different
// company spelling, or with a date-extraction drift larger than the window.
//
// Within each merged group, the highest-scoring row (see `score`) is treated as
// canonical, and every OTHER row in the group is relinked to the canonical row's
// event_id. No row is ever removed — src/lib/stats.ts counts one event per distinct
// event_id, so linked follow-up rows are not double-counted, while every article's
// citation stays in the dataset.
//
// Score heuristic (higher is better):
//   +3 confirmed status
//   +2 jobs_cut present
//   +1 pct_workforce present
//   +2 source_link is a Wayback Machine URL
//   +1 source_link is not a Google News RSS wrapper
// Tie-break: first occurrence (original row order) wins.
//
// Flags:
//   --dry-run  Compute and print what would change; do NOT write layoffs.csv.
//   --delete   Restore the pre-2026-09 behaviour: instead of linking, DELETE every
//              non-canonical row in a group (company+window grouping only — no
//              cross-group URL merge). For manual/ad-hoc use only; the scheduled
//              pipeline always links.

import { readCsv, writeCsv } from '../src/lib/csv';
import { normalizeCompany } from './normalize';
import { normalizeUrl } from './url-normalize';
import { LayoffEntry } from '../src/lib/types';

const DATE_WINDOW_DAYS = 7;

export function score(entry: LayoffEntry): number {
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
  indices: number[];
}

// Group row indices by normalized company + sliding date window (see header comment).
// Exported so both linking and legacy-deletion modes share one grouping pass, and so
// tests can assert on grouping without touching the filesystem.
export function computeCompanyWindowGroups(entries: LayoffEntry[]): number[][] {
  const byCompany = new Map<string, EventGroup[]>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const compKey = normalizeCompany(entry.company || '').toLowerCase();
    if (!byCompany.has(compKey)) byCompany.set(compKey, []);
    const groups = byCompany.get(compKey)!;
    const d = entry.date_announced || null;

    let matched = false;
    for (const group of groups) {
      if (!d || !group.anchorDate) {
        if (!d && !group.anchorDate) {
          group.indices.push(i);
          matched = true;
          break;
        }
        continue;
      }
      if (daysBetween(d, group.anchorDate) <= DATE_WINDOW_DAYS) {
        group.indices.push(i);
        if (d > group.anchorDate) group.anchorDate = d;
        matched = true;
        break;
      }
    }

    if (!matched) groups.push({ anchorDate: d, indices: [i] });
  }

  const out: number[][] = [];
  for (const groups of byCompany.values()) {
    for (const group of groups) out.push(group.indices);
  }
  return out;
}

export interface LinkChange {
  company: string;
  date_announced: string;
  source_link: string;
  fromEventId: string;
  toEventId: string;
}

export interface LinkResult {
  // Same length and order as the input; event_id updated in place where linked.
  entries: LayoffEntry[];
  changes: LinkChange[];
}

// Pure linking pass — no filesystem access, so it's directly testable with synthetic
// fixtures. Groups by company+window (above), then additionally unions any two groups
// that share an identical normalized source_link, then relinks every row in each
// merged group to the canonical row's event_id.
export function linkDuplicateEvents(entries: LayoffEntry[]): LinkResult {
  const flatGroups = computeCompanyWindowGroups(entries);
  const groupOfIndex = new Array<number>(entries.length).fill(-1);
  flatGroups.forEach((indices, gid) => {
    for (const i of indices) groupOfIndex[i] = gid;
  });

  // Union-find over GROUPS (not individual rows) so a shared URL merges two whole
  // company/window groups in one step.
  const parent = flatGroups.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const urlToGroup = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const u = normalizeUrl(entries[i].source_link || '');
    if (!u) continue;
    const gid = groupOfIndex[i];
    const prev = urlToGroup.get(u);
    if (prev != null) union(prev, gid);
    else urlToGroup.set(u, gid);
  }

  const merged = new Map<number, number[]>(); // root group id -> row indices
  for (let i = 0; i < entries.length; i++) {
    const root = find(groupOfIndex[i]);
    const arr = merged.get(root);
    if (arr) arr.push(i);
    else merged.set(root, [i]);
  }

  const outEntries = entries.map((e) => ({ ...e }));
  const changes: LinkChange[] = [];

  for (const indices of merged.values()) {
    if (indices.length < 2) continue;

    // Highest score wins; ties keep first-occurrence (original row order).
    const sorted = [...indices].sort((a, b) => {
      const sd = score(entries[b]) - score(entries[a]);
      if (sd !== 0) return sd;
      return a - b;
    });
    const canonicalEventId = entries[sorted[0]].event_id;
    if (!canonicalEventId) continue; // nothing usable to link to

    for (const i of indices) {
      if (outEntries[i].event_id !== canonicalEventId) {
        changes.push({
          company: outEntries[i].company,
          date_announced: outEntries[i].date_announced,
          source_link: outEntries[i].source_link,
          fromEventId: outEntries[i].event_id,
          toEventId: canonicalEventId,
        });
        outEntries[i].event_id = canonicalEventId;
      }
    }
  }

  return { entries: outEntries, changes };
}

export interface DeletionGroup {
  canonical: LayoffEntry;
  removed: LayoffEntry[];
}

// Legacy behaviour (pre-2026-09): delete every non-canonical row in a group. Kept for
// manual use behind --delete. Deliberately does NOT do the cross-group URL merge, to
// match the original script's scope exactly.
export function dedupByDeletion(entries: LayoffEntry[]): {
  kept: LayoffEntry[];
  removedGroups: DeletionGroup[];
} {
  const flatGroups = computeCompanyWindowGroups(entries);
  const kept: LayoffEntry[] = [];
  const removedGroups: DeletionGroup[] = [];

  for (const indices of flatGroups) {
    const group = indices.map((i) => entries[i]);
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => score(b) - score(a));
    kept.push(sorted[0]);
    removedGroups.push({ canonical: sorted[0], removed: sorted.slice(1) });
  }

  return { kept, removedGroups };
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const deleteMode = args.includes('--delete');

  const entries = readCsv('layoffs.csv');

  if (deleteMode) {
    const { kept, removedGroups } = dedupByDeletion(entries);

    if (removedGroups.length === 0) {
      console.log('No duplicates found.');
      return;
    }

    for (const g of removedGroups) {
      const dates = [g.canonical, ...g.removed]
        .map((e) => e.date_announced)
        .filter(Boolean)
        .join(', ');
      console.log(` • ${g.canonical.company} [${dates}] (kept 1 of ${g.removed.length + 1})`);
      for (const dup of g.removed) {
        console.log(`  removed: ${dup.company} ${dup.date_announced} — ${dup.source_link}`);
      }
    }

    const removedCount = entries.length - kept.length;
    if (!dryRun) writeCsv('layoffs.csv', kept);
    console.log(
      `\n${dryRun ? '[dry-run] Would remove' : 'Removed'} ${removedCount} duplicate rows.`
    );
    console.log(
      `layoffs.csv: ${entries.length} → ${kept.length} rows${dryRun ? ' (dry-run, not written)' : ''}`
    );
    return;
  }

  const { entries: linked, changes } = linkDuplicateEvents(entries);

  if (changes.length === 0) {
    console.log('No duplicates found to link.');
    return;
  }

  console.log(`Linking ${changes.length} row(s) to a canonical event_id:`);
  for (const c of changes) {
    console.log(
      `  • ${c.company} (${c.date_announced}) ${c.fromEventId} → ${c.toEventId}  [${c.source_link}]`
    );
  }

  if (!dryRun) {
    writeCsv('layoffs.csv', linked);
    console.log(`\nlayoffs.csv: updated event_id on ${changes.length} row(s).`);
  } else {
    console.log(`\n[dry-run] ${changes.length} row(s) would be relinked; layoffs.csv NOT written.`);
  }
}

// CLI entry point — only when run directly (tsx scripts/dedup-layoffs.ts), not when
// imported by tests (see tests/dedup-layoffs.test.ts).
if (process.argv[1]?.endsWith('dedup-layoffs.ts')) {
  main();
}
