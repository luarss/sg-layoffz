import { describe, it, expect } from 'vitest';
import { groupEntriesByEvent, getEventKey } from '../src/lib/groupEvents';
import { LayoffEntry } from '../src/lib/types';

function makeEntry(over: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'Acme',
    date_announced: '2026-05-01',
    date_reported: '2026-05-01',
    jobs_cut_sg: null,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Tech',
    source_link: 'https://www.example.com/1',
    notes: 'Initial announcement',
    status: 'confirmed',
    event_id: 'acme-2026-05',
    ...over,
  };
}

describe('DataTable - groupEntriesByEvent', () => {
  it('returns empty array when entries is empty', () => {
    expect(groupEntriesByEvent([])).toEqual([]);
  });

  it('keeps single entries as standalone event with empty followUps', () => {
    const e1 = makeEntry({ company: 'Company A', event_id: 'comp-a' });
    const e2 = makeEntry({ company: 'Company B', event_id: 'comp-b' });

    const grouped = groupEntriesByEvent([e1, e2]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].company).toBe('Company A');
    expect(grouped[0].followUps).toEqual([]);
    expect(grouped[1].company).toBe('Company B');
    expect(grouped[1].followUps).toEqual([]);
  });

  it('groups multiple rows sharing the same event_id under one primary row', () => {
    const e1 = makeEntry({
      company: 'Standard Chartered',
      date_announced: '2026-05-19',
      notes: 'Initial coverage',
      event_id: 'stanchart-2026',
    });
    const e2 = makeEntry({
      company: 'Standard Chartered',
      date_announced: '2026-05-30',
      jobs_cut_global: 7800,
      notes: 'Second update',
      event_id: 'stanchart-2026',
    });
    const e3 = makeEntry({
      company: 'Standard Chartered Bank',
      date_announced: '2026-06-25',
      notes: 'Union response',
      event_id: 'stanchart-2026',
    });

    const grouped = groupEntriesByEvent([e3, e2, e1]); // input in any order
    expect(grouped).toHaveLength(1);

    const primary = grouped[0];
    expect(primary.eventId).toBe('stanchart-2026');
    // Primary row should be the earliest announced date
    expect(primary.date_announced).toBe('2026-05-19');
    expect(primary.notes).toBe('Initial coverage');
    expect(primary.jobs_cut_global).toBe(7800); // Rollup from follow-up

    // Follow-ups should contain the other 2 rows in chronological order
    expect(primary.followUps).toHaveLength(2);
    expect(primary.followUps[0].date_announced).toBe('2026-05-30');
    expect(primary.followUps[0].notes).toBe('Second update');
    expect(primary.followUps[1].date_announced).toBe('2026-06-25');
    expect(primary.followUps[1].company).toBe('Standard Chartered Bank');
  });

  it('rolls up max jobs_cut_sg and confirmed status to primary row if primary lacked them', () => {
    const primaryRow = makeEntry({
      event_id: 'true-fitness',
      date_announced: '2026-09-11',
      status: 'rumored',
      jobs_cut_sg: null,
    });
    const followUpRow = makeEntry({
      event_id: 'true-fitness',
      date_announced: '2026-09-13',
      status: 'confirmed',
      jobs_cut_sg: 200,
    });

    const grouped = groupEntriesByEvent([primaryRow, followUpRow]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].jobs_cut_sg).toBe(200);
    expect(grouped[0].status).toBe('confirmed');
    expect(grouped[0].followUps).toHaveLength(1);
    expect(grouped[0].followUps[0].jobs_cut_sg).toBe(200);
  });

  it('does not merge separate rows when event_id is blank or missing', () => {
    const e1 = makeEntry({ company: 'Alpha', date_announced: '2026-01-01', event_id: '', source_link: 'https://a.com' });
    const e2 = makeEntry({ company: 'Beta', date_announced: '2026-01-02', event_id: '  ', source_link: 'https://b.com' });

    const grouped = groupEntriesByEvent([e1, e2]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].company).toBe('Beta'); // sorted descending by date
    expect(grouped[1].company).toBe('Alpha');
    expect(grouped[0].followUps).toHaveLength(0);
    expect(grouped[1].followUps).toHaveLength(0);
  });

  it('tie-breaks identical dates by confirmed status and disclosed headcount', () => {
    const r1 = makeEntry({
      event_id: 'ev-same-date',
      date_announced: '2026-04-01',
      status: 'rumored',
      jobs_cut_sg: null,
    });
    const r2 = makeEntry({
      event_id: 'ev-same-date',
      date_announced: '2026-04-01',
      status: 'confirmed',
      jobs_cut_sg: 50,
    });

    const grouped = groupEntriesByEvent([r1, r2]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].status).toBe('confirmed');
    expect(grouped[0].jobs_cut_sg).toBe(50);
    expect(grouped[0].followUps).toHaveLength(1);
  });
});
