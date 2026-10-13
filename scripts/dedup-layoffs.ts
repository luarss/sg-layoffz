// Links duplicate data/layoffs.csv rows to a shared event_id instead of deleting them,
// and dedupes data/rejected.csv by normalized source_link.
//
// Passes over layoffs.csv, in order:
//   1. Curated merges (data/event-merges.csv): every row whose event_id is a
//      from_event_id is relinked to its to_event_id, resolved transitively
//      (a→b, b→c relinks a straight to c). The run aborts if a merge chain cycles,
//      a from_event_id is listed twice with different targets, a merge contradicts
//      data/distinct-events.csv, or the final target event_id has no row in the data.
//   2. Company + window grouping: rows are grouped by normalized company name using a
//      sliding AUTO_LINK_WINDOW_DAYS (7-day) window on date_announced (handles day-off
//      reporting lag like "May 20 vs May 21" for Meta). The window slides: when a new
//      entry joins a group, anchorDate advances to the new entry's date, so a chain
//      May 1 → May 5 → May 9 all merges. Rows anywhere in the file that share an
//      identical normalized source_link are ALSO merged into one group, even across
//      different company keys or outside the date window — this catches the same
//      article re-scraped under a slightly different company spelling, or with a
//      date-extraction drift larger than the window.
//   3. Same-month slug drift: two groups are merged when they hold rows of the same
//      normalized company whose event_ids share one month base. The month base of an
//      event_id is everything up to and including its first "-YYYY-MM", provided the
//      remainder is empty or a descriptive suffix starting with a letter:
//        "kanada-ya-2026-07-closure" and "kanada-ya-2026-07" → "kanada-ya-2026-07"
//        "porcelain-2026-07" and "porcelain-2026-08"          → different months, kept apart
//        "toms-palette-2026-closure"                          → no month, never merged here
//   Pairs listed in data/distinct-events.csv are never merged by passes 2 or 3.
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
// rejected.csv: rows sharing a normalized source_link (scripts/url-normalize.ts) are
// collapsed to the first occurrence. Always runs; rows without a link are kept.
//
// Flags:
//   --dry-run  Compute and print what would change; do NOT write any CSV.
//   --delete   Restore the pre-2026-09 behaviour: instead of linking, DELETE every
//              non-canonical row in a group (company+window grouping only — no
//              cross-group URL merge, no curated merges). For manual/ad-hoc use only;
//              the scheduled pipeline always links.

import fs from 'node:fs';
import { readCsv, readCsvFile, writeCsv } from '../src/lib/csv';
import { companyKey } from './normalize';
import { normalizeUrl } from './url-normalize';
import { LayoffEntry } from '../src/lib/types';
import { withinDays } from '../src/lib/dates';
import { rowQualityScore } from '../src/lib/rowQuality';
import { AUTO_LINK_WINDOW_DAYS } from './same-event';

export function score(entry: LayoffEntry): number {
  return rowQualityScore(entry);
}

export interface EventMerge {
  from_event_id: string;
  to_event_id: string;
  why?: string;
}

export interface DistinctEvents {
  event_id_a: string;
  event_id_b: string;
  why?: string;
}

export type DistinctPairs = Set<string>;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildDistinctPairs(rows: DistinctEvents[]): DistinctPairs {
  return new Set(rows.map((row) => pairKey(row.event_id_a, row.event_id_b)));
}

function isDistinctFromAny(eventId: string, others: Iterable<string>, distinct: DistinctPairs): boolean {
  if (distinct.size === 0 || !eventId) return false;
  for (const other of others) {
    if (other && other !== eventId && distinct.has(pairKey(eventId, other))) return true;
  }
  return false;
}

function setsAreDistinct(a: Set<string>, b: Set<string>, distinct: DistinctPairs): boolean {
  for (const id of a) {
    if (isDistinctFromAny(id, b, distinct)) return true;
  }
  return false;
}

function directMergeTargets(merges: EventMerge[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const { from_event_id: from, to_event_id: to } of merges) {
    if (!from || !to) throw new Error(`event-merges: blank id in merge "${from}" → "${to}"`);
    if (from === to) throw new Error(`event-merges: "${from}" merges into itself`);
    const existing = targets.get(from);
    if (existing && existing !== to) {
      throw new Error(`event-merges: "${from}" merges into both "${existing}" and "${to}"`);
    }
    targets.set(from, to);
  }
  return targets;
}

function followChain(start: string, targets: Map<string, string>): string {
  const seen = new Set<string>([start]);
  let current = targets.get(start)!;
  while (targets.has(current)) {
    if (seen.has(current)) throw new Error(`event-merges: cycle through "${current}"`);
    seen.add(current);
    current = targets.get(current)!;
  }
  if (seen.has(current)) throw new Error(`event-merges: cycle through "${current}"`);
  return current;
}

export function resolveMergeTargets(merges: EventMerge[]): Map<string, string> {
  const direct = directMergeTargets(merges);
  const resolved = new Map<string, string>();
  for (const from of direct.keys()) resolved.set(from, followChain(from, direct));
  return resolved;
}

function assertMergesRespectDistinct(resolved: Map<string, string>, distinct: DistinctPairs): void {
  for (const [from, to] of resolved) {
    if (distinct.has(pairKey(from, to))) {
      throw new Error(`event-merges: "${from}" → "${to}" contradicts distinct-events.csv`);
    }
  }
}

function assertTargetsExist(resolved: Map<string, string>, entries: LayoffEntry[]): void {
  const present = new Set(entries.map((entry) => entry.event_id));
  for (const [from, to] of resolved) {
    if (!present.has(to)) {
      throw new Error(`event-merges: target "${to}" (from "${from}") has no row in layoffs.csv`);
    }
  }
}

export interface AppliedMerge {
  fromEventId: string;
  toEventId: string;
  rows: number;
}

export interface MergeResult {
  entries: LayoffEntry[];
  applied: AppliedMerge[];
}

export function applyEventMerges(
  entries: LayoffEntry[],
  merges: EventMerge[],
  distinct: DistinctPairs = new Set()
): MergeResult {
  const resolved = resolveMergeTargets(merges);
  assertMergesRespectDistinct(resolved, distinct);
  assertTargetsExist(resolved, entries);

  const rowsMoved = new Map<string, number>();
  const outEntries = entries.map((entry) => {
    const target = resolved.get(entry.event_id);
    if (!target) return { ...entry };
    rowsMoved.set(entry.event_id, (rowsMoved.get(entry.event_id) ?? 0) + 1);
    return { ...entry, event_id: target };
  });

  const applied = [...rowsMoved].map(([fromEventId, rows]) => ({
    fromEventId,
    toEventId: resolved.get(fromEventId)!,
    rows,
  }));
  return { entries: outEntries, applied };
}

export function monthBaseEventId(eventId: string): string | null {
  const match = (eventId || '').match(/^(.+?-\d{4}-(?:0[1-9]|1[0-2]))(?:-([a-z][a-z0-9-]*))?$/);
  return match ? match[1] : null;
}

interface EventGroup {
  anchorDate: string | null;
  indices: number[];
  eventIds: Set<string>;
}

function groupAccepts(group: EventGroup, entry: LayoffEntry, distinct: DistinctPairs): boolean {
  if (isDistinctFromAny(entry.event_id, group.eventIds, distinct)) return false;
  const date = entry.date_announced || null;
  if (!date || !group.anchorDate) return !date && !group.anchorDate;
  return withinDays(date, group.anchorDate, AUTO_LINK_WINDOW_DAYS);
}

function addToGroup(group: EventGroup, entry: LayoffEntry, index: number): void {
  group.indices.push(index);
  group.eventIds.add(entry.event_id);
  const date = entry.date_announced || null;
  if (date && group.anchorDate && date > group.anchorDate) group.anchorDate = date;
}

// Group row indices by normalized company + sliding date window (see header comment).
// Exported so both linking and legacy-deletion modes share one grouping pass, and so
// tests can assert on grouping without touching the filesystem.
export function computeCompanyWindowGroups(
  entries: LayoffEntry[],
  distinct: DistinctPairs = new Set()
): number[][] {
  const byCompany = new Map<string, EventGroup[]>();

  entries.forEach((entry, index) => {
    const key = companyKey(entry.company || '');
    if (!byCompany.has(key)) byCompany.set(key, []);
    const groups = byCompany.get(key)!;
    const match = groups.find((group) => groupAccepts(group, entry, distinct));
    if (match) addToGroup(match, entry, index);
    else {
      groups.push({
        anchorDate: entry.date_announced || null,
        indices: [index],
        eventIds: new Set([entry.event_id]),
      });
    }
  });

  const out: number[][] = [];
  for (const groups of byCompany.values()) {
    for (const group of groups) out.push(group.indices);
  }
  return out;
}

class GroupUnion {
  private parent: number[];
  private eventIds: Set<string>[];

  constructor(groups: number[][], entries: LayoffEntry[], private distinct: DistinctPairs) {
    this.parent = groups.map((_, i) => i);
    this.eventIds = groups.map((indices) => new Set(indices.map((i) => entries[i].event_id)));
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    if (setsAreDistinct(this.eventIds[rootA], this.eventIds[rootB], this.distinct)) return;
    this.parent[rootA] = rootB;
    for (const id of this.eventIds[rootA]) this.eventIds[rootB].add(id);
  }
}

function unionByKey(
  entries: LayoffEntry[],
  groupOfIndex: number[],
  groupUnion: GroupUnion,
  keyOf: (entry: LayoffEntry) => string | null
): void {
  const firstGroupForKey = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = keyOf(entry);
    if (!key) return;
    const previous = firstGroupForKey.get(key);
    if (previous != null) groupUnion.union(previous, groupOfIndex[index]);
    else firstGroupForKey.set(key, groupOfIndex[index]);
  });
}

function urlKey(entry: LayoffEntry): string | null {
  return normalizeUrl(entry.source_link || '') || null;
}

function companyMonthBaseKey(entry: LayoffEntry): string | null {
  const base = monthBaseEventId(entry.event_id);
  return base ? `${companyKey(entry.company || '')}|${base}` : null;
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
  appliedMerges: AppliedMerge[];
}

export interface LinkOptions {
  merges?: EventMerge[];
  distinct?: DistinctEvents[];
}

function mergedRowGroups(entries: LayoffEntry[], distinct: DistinctPairs): number[][] {
  const flatGroups = computeCompanyWindowGroups(entries, distinct);
  const groupOfIndex = new Array<number>(entries.length).fill(-1);
  flatGroups.forEach((indices, gid) => {
    for (const i of indices) groupOfIndex[i] = gid;
  });

  const groupUnion = new GroupUnion(flatGroups, entries, distinct);
  unionByKey(entries, groupOfIndex, groupUnion, urlKey);
  unionByKey(entries, groupOfIndex, groupUnion, companyMonthBaseKey);

  const merged = new Map<number, number[]>();
  entries.forEach((_, index) => {
    const root = groupUnion.find(groupOfIndex[index]);
    const rows = merged.get(root);
    if (rows) rows.push(index);
    else merged.set(root, [index]);
  });
  return [...merged.values()];
}

function canonicalIndex(entries: LayoffEntry[], indices: number[]): number {
  return [...indices].sort((a, b) => score(entries[b]) - score(entries[a]) || a - b)[0];
}

function relinkGroup(outEntries: LayoffEntry[], indices: number[], changes: LinkChange[]): void {
  if (indices.length < 2) return;
  const canonicalEventId = outEntries[canonicalIndex(outEntries, indices)].event_id;
  if (!canonicalEventId) return;
  for (const i of indices) {
    if (outEntries[i].event_id === canonicalEventId) continue;
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

// Pure linking pass — no filesystem access, so it's directly testable with synthetic
// fixtures. See the header comment for the order of passes.
export function linkDuplicateEvents(entries: LayoffEntry[], options: LinkOptions = {}): LinkResult {
  const distinct = buildDistinctPairs(options.distinct ?? []);
  const { entries: outEntries, applied } = applyEventMerges(entries, options.merges ?? [], distinct);
  const changes: LinkChange[] = [];
  for (const indices of mergedRowGroups(outEntries, distinct)) {
    relinkGroup(outEntries, indices, changes);
  }
  return { entries: outEntries, changes, appliedMerges: applied };
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

export interface RejectedDedupResult {
  kept: LayoffEntry[];
  removed: LayoffEntry[];
}

export function dedupRejectedByUrl(rows: LayoffEntry[]): RejectedDedupResult {
  const seen = new Set<string>();
  const kept: LayoffEntry[] = [];
  const removed: LayoffEntry[] = [];
  for (const row of rows) {
    const key = normalizeUrl(row.source_link || '');
    if (key && seen.has(key)) {
      removed.push(row);
      continue;
    }
    if (key) seen.add(key);
    kept.push(row);
  }
  return { kept, removed };
}

function readDecisionCsv<T>(filename: string): T[] {
  const filePath = `${process.cwd()}/data/${filename}`;
  if (!fs.existsSync(filePath)) return [];
  return readCsvFile<T>(filePath).data;
}

function runRejectedDedup(dryRun: boolean): void {
  const rows = readCsv('rejected.csv');
  const { kept, removed } = dedupRejectedByUrl(rows);
  if (removed.length === 0) {
    console.log('rejected.csv: no duplicate source links.');
    return;
  }
  if (!dryRun) writeCsv('rejected.csv', kept);
  const verb = dryRun ? '[dry-run] would remove' : 'removed';
  console.log(`rejected.csv: ${verb} ${removed.length} duplicate-URL row(s) (${rows.length} → ${kept.length}).`);
}

function runDeleteMode(entries: LayoffEntry[], dryRun: boolean): void {
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
}

function printAppliedMerges(applied: AppliedMerge[]): void {
  if (applied.length === 0) return;
  console.log(`Applying ${applied.length} curated merge(s) from event-merges.csv:`);
  for (const merge of applied) {
    console.log(`  • ${merge.fromEventId} → ${merge.toEventId} (${merge.rows} row(s))`);
  }
}

function printChanges(changes: LinkChange[]): void {
  if (changes.length === 0) return;
  console.log(`Linking ${changes.length} row(s) to a canonical event_id:`);
  for (const c of changes) {
    console.log(
      `  • ${c.company} (${c.date_announced}) ${c.fromEventId} → ${c.toEventId}  [${c.source_link}]`
    );
  }
}

function runLinkMode(entries: LayoffEntry[], dryRun: boolean): void {
  const { entries: linked, changes, appliedMerges } = linkDuplicateEvents(entries, {
    merges: readDecisionCsv<EventMerge>('event-merges.csv'),
    distinct: readDecisionCsv<DistinctEvents>('distinct-events.csv'),
  });

  printAppliedMerges(appliedMerges);
  printChanges(changes);

  const touched = linked.filter((entry, index) => entry.event_id !== entries[index].event_id).length;
  if (touched === 0) {
    console.log('No duplicates found to link.');
    return;
  }

  if (!dryRun) {
    writeCsv('layoffs.csv', linked);
    console.log(`\nlayoffs.csv: updated event_id on ${touched} row(s).`);
  } else {
    console.log(`\n[dry-run] ${touched} row(s) would be relinked; layoffs.csv NOT written.`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const entries = readCsv('layoffs.csv');

  if (args.includes('--delete')) runDeleteMode(entries, dryRun);
  else runLinkMode(entries, dryRun);

  runRejectedDedup(dryRun);
}

// CLI entry point — only when run directly (tsx scripts/dedup-layoffs.ts), not when
// imported by tests (see tests/dedup-layoffs.test.ts).
if (process.argv[1]?.endsWith('dedup-layoffs.ts')) {
  main();
}
