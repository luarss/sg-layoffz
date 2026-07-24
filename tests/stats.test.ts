import { describe, it, expect } from 'vitest';
import { computeStats } from '../src/lib/stats';
import { LayoffEntry } from '../src/lib/types';

function entry(over: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'Acme',
    date_announced: '2026-05-01',
    date_reported: '2026-05-01',
    jobs_cut_sg: null,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Tech',
    source_link: 'https://www.straitstimes.com/example',
    notes: '',
    status: 'confirmed',
    event_id: 'acme-2026-05',
    ...over,
  };
}

describe('computeStats — event-level aggregation', () => {
  it('counts each event once, taking the MAX jobs_cut_sg across follow-up rows', () => {
    // Two rows of one event: an early report (100) and a follow-up (250). The event
    // should contribute 250 once, never 100+250.
    const stats = computeStats([
      entry({ event_id: 'e1', date_announced: '2026-05-01', jobs_cut_sg: 100 }),
      entry({ event_id: 'e1', date_announced: '2026-05-10', jobs_cut_sg: 250, source_link: 'https://x/2' }),
    ]);
    expect(stats.totalJobsCut).toBe(250);
    expect(stats.totalConfirmed).toBe(1); // one event
  });

  it('sums SG headcount across distinct confirmed events', () => {
    const stats = computeStats([
      entry({ company: 'A', event_id: 'a-1', jobs_cut_sg: 100 }),
      entry({ company: 'B', event_id: 'b-1', jobs_cut_sg: 300 }),
    ]);
    expect(stats.totalJobsCut).toBe(400);
    expect(stats.totalConfirmed).toBe(2);
    expect(stats.totalCompanies).toBe(2);
  });

  it('ignores jobs_cut_global entirely in totalJobsCut', () => {
    const stats = computeStats([
      entry({ event_id: 'g-1', jobs_cut_sg: null, jobs_cut_global: 8000 }),
    ]);
    expect(stats.totalJobsCut).toBe(0);
    expect(stats.undisclosedEvents).toBe(1); // no SG headcount disclosed
  });

  it('counts confirmed events with no SG headcount as undisclosedEvents', () => {
    const stats = computeStats([
      entry({ event_id: 'd-1', jobs_cut_sg: 50 }),
      entry({ event_id: 'd-2', jobs_cut_sg: null }),
      entry({ event_id: 'd-3', jobs_cut_sg: null, jobs_cut_global: 1000 }),
    ]);
    expect(stats.totalJobsCut).toBe(50);
    expect(stats.undisclosedEvents).toBe(2);
    expect(stats.totalConfirmed).toBe(3);
  });

  it('classifies an event with any confirmed row as confirmed (not double-counted)', () => {
    // Event e1 has one rumored and one confirmed row → counts as ONE confirmed event,
    // never also as a rumored event.
    const stats = computeStats([
      entry({ event_id: 'e1', status: 'rumored', jobs_cut_sg: null }),
      entry({ event_id: 'e1', status: 'confirmed', jobs_cut_sg: 40, source_link: 'https://x/2' }),
      entry({ event_id: 'r1', status: 'rumored', jobs_cut_sg: null }),
    ]);
    expect(stats.totalConfirmed).toBe(1);
    expect(stats.totalRumored).toBe(1);
    expect(stats.totalJobsCut).toBe(40);
  });

  it('buckets an event into its earliest row month and counts events, not rows', () => {
    const stats = computeStats([
      entry({ event_id: 'm1', date_announced: '2026-05-20', jobs_cut_sg: 30 }),
      entry({ event_id: 'm1', date_announced: '2026-06-02', jobs_cut_sg: 30, source_link: 'https://x/2' }),
      entry({ event_id: 'm2', date_announced: '2026-05-05', jobs_cut_sg: 10, company: 'B' }),
      entry({ event_id: 'r1', date_announced: '2026-05-11', status: 'rumored', company: 'C' }),
    ]);
    const may = stats.monthlyBreakdown.find((m) => m.month === '2026-05');
    expect(may).toBeDefined();
    // m1 (bucketed to its earliest row, May) + m2 → 2 confirmed events in May.
    expect(may!.count).toBe(2);
    expect(may!.jobs).toBe(40); // 30 (m1 max) + 10 (m2)
    expect(may!.rumoredCount).toBe(1);
    // June has no event bucket (m1's earliest row is in May).
    expect(stats.monthlyBreakdown.find((m) => m.month === '2026-06')).toBeUndefined();
  });
});
