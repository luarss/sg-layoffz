import { LayoffEntry, AggregateStats } from './types';

// An "event" is a set of rows sharing an event_id. Multiple rows are follow-up
// coverage of one layoff event, so all aggregation happens per event, never per row:
//   - jobs = the MAX jobs_cut_sg across the event's rows (not the sum — summing would
//     double-count the same headcount reported in several articles)
//   - an event is "confirmed" if ANY of its rows is confirmed (or reference),
//     otherwise "rumored"; this keeps an event from being counted in both buckets
//   - an event is bucketed (month / industry) by its EARLIEST row's date_announced
interface EventAgg {
  eventId: string;
  confirmed: boolean;
  jobsSg: number | null; // max jobs_cut_sg across rows, null if none disclosed
  earliestDate: string; // earliest date_announced among rows
  latestReported: string; // latest date_reported among rows
  company: string; // company of the earliest row
  industry: string; // industry of the earliest row
}

function fallbackId(e: LayoffEntry): string {
  // Defensive: a row with no event_id becomes its own event so it is never merged
  // with an unrelated blank-id row.
  return e.event_id && e.event_id.trim() !== ''
    ? e.event_id
    : `__row__:${e.company}|${e.date_announced}|${e.source_link}`;
}

function buildEvents(entries: LayoffEntry[]): EventAgg[] {
  const map = new Map<string, LayoffEntry[]>();
  for (const e of entries) {
    const id = fallbackId(e);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(e);
  }

  const events: EventAgg[] = [];
  for (const [eventId, rows] of map) {
    const confirmed = rows.some((r) => r.status === 'confirmed' || r.status === 'reference');
    const sgValues = rows.map((r) => r.jobs_cut_sg).filter((v): v is number => v != null);
    const jobsSg = sgValues.length > 0 ? Math.max(...sgValues) : null;

    const sortedByAnnounced = [...rows].sort((a, b) =>
      String(a.date_announced).localeCompare(String(b.date_announced))
    );
    const earliestDate = sortedByAnnounced[0]?.date_announced ?? '';
    const earliestRow = sortedByAnnounced[0];
    const latestReported = rows
      .map((r) => r.date_reported || r.date_announced)
      .sort((a, b) => String(b).localeCompare(String(a)))[0] ?? '';

    events.push({
      eventId,
      confirmed,
      jobsSg,
      earliestDate,
      latestReported,
      company: earliestRow?.company ?? '',
      industry: earliestRow?.industry || 'Other',
    });
  }
  return events;
}

export function computeStats(entries: LayoffEntry[]): AggregateStats {
  const events = buildEvents(entries);
  const confirmedEvents = events.filter((e) => e.confirmed);
  const rumoredEvents = events.filter((e) => !e.confirmed);

  // Total SG jobs cut = sum over confirmed EVENTS of the event's SG headcount.
  const totalJobsCut = confirmedEvents.reduce((sum, e) => sum + (e.jobsSg ?? 0), 0);

  // Confirmed events with no disclosed Singapore headcount.
  const undisclosedEvents = confirmedEvents.filter((e) => e.jobsSg == null).length;

  const companies = new Set(
    confirmedEvents.map((e) => e.company.toLowerCase()).filter((c) => c !== '')
  );

  const latestEntryDate = [...confirmedEvents]
    .map((e) => e.latestReported)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] ?? '';

  // Monthly breakdown — bucket each event by its earliest row's date_announced.
  const monthlyMap: Record<string, { jobs: number; count: number; rumoredCount: number }> = {};
  const monthKey = (date: string) => {
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };

  for (const e of confirmedEvents) {
    const key = monthKey(e.earliestDate);
    if (!key) continue;
    if (!monthlyMap[key]) monthlyMap[key] = { jobs: 0, count: 0, rumoredCount: 0 };
    monthlyMap[key].jobs += e.jobsSg ?? 0;
    monthlyMap[key].count += 1;
  }
  for (const e of rumoredEvents) {
    const key = monthKey(e.earliestDate);
    if (!key) continue;
    if (!monthlyMap[key]) monthlyMap[key] = { jobs: 0, count: 0, rumoredCount: 0 };
    monthlyMap[key].rumoredCount += 1;
  }

  const monthlyBreakdown = Object.entries(monthlyMap)
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Industry breakdown — over confirmed events.
  const industryMap: Record<string, { jobs: number; count: number }> = {};
  for (const e of confirmedEvents) {
    const ind = e.industry || 'Other';
    if (!industryMap[ind]) industryMap[ind] = { jobs: 0, count: 0 };
    industryMap[ind].jobs += e.jobsSg ?? 0;
    industryMap[ind].count += 1;
  }

  const industryBreakdown = Object.entries(industryMap)
    .map(([industry, data]) => ({ industry, ...data }))
    .sort((a, b) => b.jobs - a.jobs);

  return {
    totalJobsCut,
    totalCompanies: companies.size,
    totalConfirmed: confirmedEvents.length,
    totalRumored: rumoredEvents.length,
    undisclosedEvents,
    latestEntryDate,
    monthlyBreakdown,
    industryBreakdown,
  };
}
