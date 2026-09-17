import { describe, it, expect } from 'vitest';
import {
  linkDuplicateEvents,
  dedupByDeletion,
  computeCompanyWindowGroups,
  score,
} from '../scripts/dedup-layoffs';
import { LayoffEntry } from '../src/lib/types';

// Synthetic fixtures only — this suite must never read or write data/layoffs.csv.
// Mirrors the entry() helper pattern used by tests/cluster.test.ts and
// tests/deduplicate.test.ts.
function entry(over: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'Grab',
    date_announced: '2026-05-01',
    date_reported: '2026-05-01',
    jobs_cut_sg: null,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Tech',
    source_link: 'https://www.example.com/a',
    notes: '',
    status: 'confirmed',
    event_id: 'grab-2026-05',
    ...over,
  };
}

describe('linkDuplicateEvents', () => {
  it('links two same-company rows 3 days apart to the canonical event_id — no row removed', () => {
    const entries = [
      entry({
        company: 'Grab',
        date_announced: '2026-05-01',
        source_link: 'https://a.com/1',
        event_id: 'grab-2026-05-a',
        jobs_cut_sg: 100, // higher score -> canonical
      }),
      entry({
        company: 'Grab',
        date_announced: '2026-05-04',
        source_link: 'https://b.com/2',
        event_id: 'grab-2026-05-b',
        jobs_cut_sg: null,
      }),
    ];

    const { entries: linked, changes } = linkDuplicateEvents(entries);

    expect(linked).toHaveLength(2);
    expect(linked[0].event_id).toBe('grab-2026-05-a');
    expect(linked[1].event_id).toBe('grab-2026-05-a');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      company: 'Grab',
      fromEventId: 'grab-2026-05-b',
      toEventId: 'grab-2026-05-a',
    });
  });

  it('leaves rows more than 7 days apart untouched', () => {
    const entries = [
      entry({
        company: 'Grab',
        date_announced: '2026-05-01',
        source_link: 'https://a.com/1',
        event_id: 'grab-2026-05-a',
      }),
      entry({
        company: 'Grab',
        date_announced: '2026-05-20',
        source_link: 'https://b.com/2',
        event_id: 'grab-2026-05-b',
      }),
    ];

    const { entries: linked, changes } = linkDuplicateEvents(entries);

    expect(linked[0].event_id).toBe('grab-2026-05-a');
    expect(linked[1].event_id).toBe('grab-2026-05-b');
    expect(changes).toHaveLength(0);
  });

  it('reports no changes when the group already shares one event_id (nothing to relink)', () => {
    const entries = [
      entry({ date_announced: '2026-05-01', source_link: 'https://a.com/1', event_id: 'grab-2026-05' }),
      entry({ date_announced: '2026-05-04', source_link: 'https://b.com/2', event_id: 'grab-2026-05' }),
    ];

    const { changes } = linkDuplicateEvents(entries);
    expect(changes).toHaveLength(0);
    // Signals to the caller that the file should not be rewritten.
    expect(changes.length === 0).toBe(true);
  });

  it('merges rows sharing an identical normalized source URL even across companies/dates', () => {
    const entries = [
      entry({
        company: 'Grab',
        date_announced: '2026-05-01',
        source_link: 'https://news.example.com/article?utm_source=x',
        event_id: 'grab-2026-05',
        jobs_cut_sg: 50,
      }),
      entry({
        company: 'Grab Holdings', // different raw name, same normalized company anyway
        date_announced: '2026-09-01', // way outside the 7-day window
        source_link: 'https://NEWS.example.com/article/', // same URL, different case/trailing slash/query
        event_id: 'grab-2026-09',
        jobs_cut_sg: null,
      }),
    ];

    const { entries: linked, changes } = linkDuplicateEvents(entries);

    expect(linked[0].event_id).toBe('grab-2026-05');
    expect(linked[1].event_id).toBe('grab-2026-05');
    expect(changes).toHaveLength(1);
  });

  it('does not touch unrelated companies', () => {
    const entries = [
      entry({ company: 'Grab', date_announced: '2026-05-01', source_link: 'https://a.com/1', event_id: 'grab-2026-05' }),
      entry({ company: 'Shopee', date_announced: '2026-05-02', source_link: 'https://c.com/3', event_id: 'shopee-2026-05' }),
    ];

    const { entries: linked, changes } = linkDuplicateEvents(entries);
    expect(linked[0].event_id).toBe('grab-2026-05');
    expect(linked[1].event_id).toBe('shopee-2026-05');
    expect(changes).toHaveLength(0);
  });

  it('preserves original row order and row count (never removes a row)', () => {
    const entries = [
      entry({ date_announced: '2026-05-01', source_link: 'https://a.com/1', event_id: 'grab-a' }),
      entry({ date_announced: '2026-05-02', source_link: 'https://a.com/2', event_id: 'grab-b' }),
      entry({ date_announced: '2026-05-03', source_link: 'https://a.com/3', event_id: 'grab-c' }),
    ];
    const { entries: linked } = linkDuplicateEvents(entries);
    expect(linked.map((e) => e.source_link)).toEqual(entries.map((e) => e.source_link));
  });
});

describe('computeCompanyWindowGroups', () => {
  it('chains a run of dates within the sliding 7-day window into one group', () => {
    const entries = [
      entry({ date_announced: '2026-05-01' }),
      entry({ date_announced: '2026-05-07' }), // 6 days from first
      entry({ date_announced: '2026-05-13' }), // 6 days from second, 12 from first
    ];
    const groups = computeCompanyWindowGroups(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([0, 1, 2]);
  });
});

describe('dedupByDeletion (--delete legacy behaviour)', () => {
  it('keeps only the highest-scoring row per group and removes the rest', () => {
    const entries = [
      entry({ date_announced: '2026-05-01', jobs_cut_sg: 100, event_id: 'grab-a' }),
      entry({ date_announced: '2026-05-03', jobs_cut_sg: null, event_id: 'grab-b' }),
    ];
    const { kept, removedGroups } = dedupByDeletion(entries);
    expect(kept).toHaveLength(1);
    expect(kept[0].event_id).toBe('grab-a');
    expect(removedGroups).toHaveLength(1);
    expect(removedGroups[0].removed).toHaveLength(1);
    expect(removedGroups[0].removed[0].event_id).toBe('grab-b');
  });
});

describe('score', () => {
  it('ranks confirmed + headcount + archived source above a bare rumored row', () => {
    const rich = entry({ status: 'confirmed', jobs_cut_sg: 10, source_link: 'https://web.archive.org/web/2026/https://x.com' });
    const sparse = entry({ status: 'rumored', jobs_cut_sg: null, source_link: 'https://news.google.com/rss/x' });
    expect(score(rich)).toBeGreaterThan(score(sparse));
  });
});
