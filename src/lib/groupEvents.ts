import { LayoffEntry } from './types';

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

    // Sort rows: earliest date_announced first for the primary row
    const sorted = [...rows].sort((a, b) => {
      const cmp = String(a.date_announced).localeCompare(String(b.date_announced));
      if (cmp !== 0) return cmp;
      const aConf = a.status === 'confirmed' ? 1 : 0;
      const bConf = b.status === 'confirmed' ? 1 : 0;
      if (bConf !== aConf) return bConf - aConf;
      const aJobs = a.jobs_cut_sg != null ? 1 : 0;
      const bJobs = b.jobs_cut_sg != null ? 1 : 0;
      return bJobs - aJobs;
    });

    const primary = sorted[0];
    const followUps = sorted.slice(1);

    // Event-level rollup metrics
    const confirmed = rows.some((r) => r.status === 'confirmed' || r.status === 'reference');
    const sgValues = rows.map((r) => r.jobs_cut_sg).filter((v): v is number => v != null);
    const maxJobsSg = sgValues.length > 0 ? Math.max(...sgValues) : null;
    const globalValues = rows.map((r) => r.jobs_cut_global).filter((v): v is number => v != null);
    const maxJobsGlobal = globalValues.length > 0 ? Math.max(...globalValues) : null;

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
