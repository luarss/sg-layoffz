import { describe, it, expect } from 'vitest';
import {
  linkDuplicateEvents,
  dedupByDeletion,
  computeCompanyWindowGroups,
  score,
  applyEventMerges,
  resolveMergeTargets,
  monthBaseEventId,
  buildDistinctPairs,
  dedupRejectedByUrl,
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
        event_id: 'grab-first-round',
      }),
      entry({
        company: 'Grab',
        date_announced: '2026-05-20',
        source_link: 'https://b.com/2',
        event_id: 'grab-second-round',
      }),
    ];

    const { entries: linked, changes } = linkDuplicateEvents(entries);

    expect(linked[0].event_id).toBe('grab-first-round');
    expect(linked[1].event_id).toBe('grab-second-round');
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

describe('applyEventMerges (pass 1: curated merges)', () => {
  const rows = () => [
    entry({ event_id: 'acme-2026-05', source_link: 'https://a.com/1' }),
    entry({ event_id: 'acme-hq-move-2026', source_link: 'https://a.com/2' }),
    entry({ event_id: 'acme-2026-07', source_link: 'https://a.com/3' }),
  ];

  it('relinks every from_event_id row to its to_event_id and reports the merge', () => {
    const { entries, applied } = applyEventMerges(rows(), [
      { from_event_id: 'acme-hq-move-2026', to_event_id: 'acme-2026-05' },
    ]);
    expect(entries.map((e) => e.event_id)).toEqual(['acme-2026-05', 'acme-2026-05', 'acme-2026-07']);
    expect(applied).toEqual([{ fromEventId: 'acme-hq-move-2026', toEventId: 'acme-2026-05', rows: 1 }]);
  });

  it('resolves merge chains transitively', () => {
    const { entries } = applyEventMerges(rows(), [
      { from_event_id: 'acme-2026-07', to_event_id: 'acme-hq-move-2026' },
      { from_event_id: 'acme-hq-move-2026', to_event_id: 'acme-2026-05' },
    ]);
    expect(new Set(entries.map((e) => e.event_id))).toEqual(new Set(['acme-2026-05']));
  });

  it('does not mutate its input', () => {
    const input = rows();
    applyEventMerges(input, [{ from_event_id: 'acme-2026-07', to_event_id: 'acme-2026-05' }]);
    expect(input[2].event_id).toBe('acme-2026-07');
  });

  it('rejects a cycle', () => {
    expect(() =>
      resolveMergeTargets([
        { from_event_id: 'a', to_event_id: 'b' },
        { from_event_id: 'b', to_event_id: 'a' },
      ])
    ).toThrow(/cycle/);
  });

  it('rejects a self-merge and a from_event_id with two different targets', () => {
    expect(() => resolveMergeTargets([{ from_event_id: 'a', to_event_id: 'a' }])).toThrow(/itself/);
    expect(() =>
      resolveMergeTargets([
        { from_event_id: 'a', to_event_id: 'b' },
        { from_event_id: 'a', to_event_id: 'c' },
      ])
    ).toThrow(/both/);
  });

  it('rejects a target event_id that has no row in the data', () => {
    expect(() =>
      applyEventMerges(rows(), [{ from_event_id: 'acme-2026-07', to_event_id: 'acme-missing' }])
    ).toThrow(/no row/);
  });

  it('rejects a merge that contradicts a distinct-events pair', () => {
    const distinct = buildDistinctPairs([{ event_id_a: 'acme-2026-05', event_id_b: 'acme-2026-07' }]);
    expect(() =>
      applyEventMerges(rows(), [{ from_event_id: 'acme-2026-07', to_event_id: 'acme-2026-05' }], distinct)
    ).toThrow(/distinct/);
  });

  it('is applied by linkDuplicateEvents before the grouping passes', () => {
    const { entries, appliedMerges } = linkDuplicateEvents(rows(), {
      merges: [{ from_event_id: 'acme-2026-07', to_event_id: 'acme-2026-05' }],
    });
    expect(entries[2].event_id).toBe('acme-2026-05');
    expect(appliedMerges).toHaveLength(1);
  });
});

describe('monthBaseEventId', () => {
  it('strips a descriptive suffix after the first YYYY-MM', () => {
    expect(monthBaseEventId('kanada-ya-2026-07-closure')).toBe('kanada-ya-2026-07');
    expect(monthBaseEventId('kanada-ya-2026-07')).toBe('kanada-ya-2026-07');
    expect(monthBaseEventId('acme-2025-12-steam-cracker-closure')).toBe('acme-2025-12');
  });

  it('returns null when there is no month or the suffix is not descriptive', () => {
    expect(monthBaseEventId('toms-palette-2026-closure')).toBeNull();
    expect(monthBaseEventId('acme-2026-13')).toBeNull();
    expect(monthBaseEventId('acme-2026-07-15')).toBeNull();
    expect(monthBaseEventId('')).toBeNull();
  });
});

describe('linkDuplicateEvents (pass 3: same-month slug drift)', () => {
  it('links same-company ids that differ only by a descriptive suffix within one month', () => {
    const entries = [
      entry({ company: 'Kanada-Ya', date_announced: '2026-07-01', source_link: 'https://a.com/1', event_id: 'kanada-ya-2026-07', jobs_cut_sg: 20 }),
      entry({ company: 'Kanada-Ya', date_announced: '2026-07-25', source_link: 'https://b.com/2', event_id: 'kanada-ya-2026-07-closure' }),
    ];
    const { entries: linked, changes } = linkDuplicateEvents(entries);
    expect(linked.map((e) => e.event_id)).toEqual(['kanada-ya-2026-07', 'kanada-ya-2026-07']);
    expect(changes).toHaveLength(1);
  });

  it('never links different months', () => {
    const entries = [
      entry({ company: 'Porcelain', date_announced: '2026-07-20', source_link: 'https://a.com/1', event_id: 'porcelain-2026-07' }),
      entry({ company: 'Porcelain', date_announced: '2026-08-02', source_link: 'https://b.com/2', event_id: 'porcelain-2026-08-liquidation' }),
    ];
    const { changes } = linkDuplicateEvents(entries);
    expect(changes).toHaveLength(0);
  });

  it('never links different companies that happen to share a month base', () => {
    const entries = [
      entry({ company: 'Grab', date_announced: '2026-05-01', source_link: 'https://a.com/1', event_id: 'sea-2026-05' }),
      entry({ company: 'Shopee', date_announced: '2026-05-20', source_link: 'https://b.com/2', event_id: 'sea-2026-05-ai' }),
    ];
    const { changes } = linkDuplicateEvents(entries);
    expect(changes).toHaveLength(0);
  });

  it('respects distinct-events pairs', () => {
    const entries = [
      entry({ company: 'Amazon', date_announced: '2026-07-02', source_link: 'https://a.com/1', event_id: 'amazon-2026-07' }),
      entry({ company: 'Amazon', date_announced: '2026-07-23', source_link: 'https://b.com/2', event_id: 'amazon-2026-07-agi' }),
    ];
    const { changes } = linkDuplicateEvents(entries, {
      distinct: [{ event_id_a: 'amazon-2026-07', event_id_b: 'amazon-2026-07-agi' }],
    });
    expect(changes).toHaveLength(0);
  });
});

describe('distinct-events in the window and URL passes', () => {
  it('keeps a distinct pair apart even inside the 7-day window', () => {
    const entries = [
      entry({ date_announced: '2026-05-01', source_link: 'https://a.com/1', event_id: 'grab-round-one' }),
      entry({ date_announced: '2026-05-03', source_link: 'https://b.com/2', event_id: 'grab-round-two' }),
    ];
    const distinct = [{ event_id_a: 'grab-round-one', event_id_b: 'grab-round-two' }];
    expect(computeCompanyWindowGroups(entries, buildDistinctPairs(distinct))).toHaveLength(2);
    expect(linkDuplicateEvents(entries, { distinct }).changes).toHaveLength(0);
  });

  it('keeps a distinct pair apart even when they share a source URL', () => {
    const entries = [
      entry({ date_announced: '2026-05-01', source_link: 'https://a.com/1', event_id: 'grab-round-one' }),
      entry({ date_announced: '2026-09-01', source_link: 'https://a.com/1', event_id: 'grab-round-two' }),
    ];
    const { changes } = linkDuplicateEvents(entries, {
      distinct: [{ event_id_a: 'grab-round-two', event_id_b: 'grab-round-one' }],
    });
    expect(changes).toHaveLength(0);
  });
});

describe('dedupRejectedByUrl', () => {
  it('keeps the first row per normalized source_link and reports the rest', () => {
    const rows = [
      entry({ company: 'First', source_link: 'https://news.example.com/story?utm_source=x' }),
      entry({ company: 'Second', source_link: 'https://www.news.example.com/story/' }),
      entry({ company: 'Other', source_link: 'https://news.example.com/other' }),
    ];
    const { kept, removed } = dedupRejectedByUrl(rows);
    expect(kept.map((r) => r.company)).toEqual(['First', 'Other']);
    expect(removed.map((r) => r.company)).toEqual(['Second']);
  });

  it('keeps every row that has no source link', () => {
    const rows = [entry({ source_link: '' }), entry({ source_link: '' })];
    expect(dedupRejectedByUrl(rows).kept).toHaveLength(2);
  });
});
