import { LayoffEntry } from './types';
import { rowQualityScore } from './rowQuality';

export interface GroupedEventEntry extends LayoffEntry {
  eventId: string;
  followUps: LayoffEntry[];
}

export function getEventKey(entry: LayoffEntry, index: number): string {
  if (entry.event_id && entry.event_id.trim() !== '') {
    return entry.event_id.trim();
  }
  // Defensive: a row without an event_id becomes its own unique event
  return `__row__:${entry.company}|${entry.date_announced}|${entry.source_link || index}`;
}

export interface EventRollup {
  confirmed: boolean;
  maxJobsSg: number | null;
  maxJobsGlobal: number | null;
}

function maxOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0 ? Math.max(...present) : null;
}

export function rollupEvent(rows: LayoffEntry[]): EventRollup {
  return {
    confirmed: rows.some((r) => r.status === 'confirmed' || r.status === 'reference'),
    maxJobsSg: maxOrNull(rows.map((r) => r.jobs_cut_sg)),
    maxJobsGlobal: maxOrNull(rows.map((r) => r.jobs_cut_global)),
  };
}

function compareCanonical(a: LayoffEntry, b: LayoffEntry): number {
  const byDate = String(a.date_announced).localeCompare(String(b.date_announced));
  if (byDate !== 0) return byDate;
  return rowQualityScore(b) - rowQualityScore(a);
}

export function groupEntriesByEvent(entries: LayoffEntry[]): GroupedEventEntry[] {
  const groupsMap = new Map<string, { eventId: string; rows: LayoffEntry[] }>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const key = getEventKey(e, i);
    let group = groupsMap.get(key);
    if (!group) {
      group = { eventId: key, rows: [] };
      groupsMap.set(key, group);
    }
    group.rows.push(e);
  }

  const result: GroupedEventEntry[] = [];

  for (const { eventId, rows } of groupsMap.values()) {
    if (rows.length === 1) {
      result.push({
        ...rows[0],
        eventId,
        followUps: [],
      });
      continue;
    }

    const sorted = [...rows].sort(compareCanonical);
    const primary = sorted[0];
    const followUps = sorted.slice(1);
    const { confirmed, maxJobsSg, maxJobsGlobal } = rollupEvent(rows);

    result.push({
      ...primary,
      eventId,
      status: confirmed
        ? primary.status === 'confirmed' || primary.status === 'reference'
          ? primary.status
          : 'confirmed'
        : primary.status,
      jobs_cut_sg: primary.jobs_cut_sg ?? maxJobsSg,
      jobs_cut_global: primary.jobs_cut_global ?? maxJobsGlobal,
      followUps,
    });
  }

  // Initial display sort: newest date_announced first
  result.sort((a, b) => String(b.date_announced).localeCompare(String(a.date_announced)));

  return result;
}
