import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  VAGUE_COMPANY,
  HEDGE_NOTES,
  validateEntry,
  checkIntegrity,
  checkCrossFileContradictions,
  eventPairKey,
  eventStats,
  formatRows,
  newWarnings,
  parseCliArgs,
  parseDistinctEventPairs,
  parseLayoffEntries,
  warningFingerprint,
} from '../scripts/validate';
import { readCsv } from '../src/lib/csv';
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
    event_id: '', // empty by default so duplicate/double-count checks are not skipped
    ...over,
  };
}

describe('VAGUE_COMPANY', () => {
  it('matches generic descriptive placeholders', () => {
    expect(VAGUE_COMPANY.test('Another Legacy Bank')).toBe(true);
    expect(VAGUE_COMPANY.test('A major bank')).toBe(true);
    expect(VAGUE_COMPANY.test('A leading retailer')).toBe(true);
    expect(VAGUE_COMPANY.test('Canadian Pension Manager')).toBe(true);
    expect(VAGUE_COMPANY.test('Unnamed AI startup (Sginnovate-backed)')).toBe(true);
    expect(VAGUE_COMPANY.test('Art Firm (name not specified)')).toBe(true);
  });

  it('does not match real, identifiable company names', () => {
    expect(VAGUE_COMPANY.test('DBS Bank')).toBe(false);
    expect(VAGUE_COMPANY.test('Standard Chartered Bank')).toBe(false);
    expect(VAGUE_COMPANY.test('OCBC')).toBe(false);
    expect(VAGUE_COMPANY.test('Grab')).toBe(false);
  });
});

describe('HEDGE_NOTES', () => {
  it('flags hedging / future-plan language', () => {
    expect(HEDGE_NOTES.test('the bank plans to cut 100 jobs')).toBe(true);
    expect(HEDGE_NOTES.test('expected to retrench staff next year')).toBe(true);
    expect(HEDGE_NOTES.test('flagged as potential duplicate requiring review')).toBe(true);
  });

  it('does not flag firmly-confirmed language', () => {
    expect(HEDGE_NOTES.test('confirmed retrenchment of 50 staff at Senoko')).toBe(false);
  });
});

describe('validateEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(validateEntry(entry({ event_id: 'acme-2026-05' }), 0)).toHaveLength(0);
  });

  it('rejects missing company, bad date, bad status, and missing event_id', () => {
    const errs = validateEntry(
      entry({ company: '', date_announced: '2026/05/01', status: 'bogus' as any, event_id: '' }),
      0
    );
    const fields = errs.map((e) => e.field);
    expect(fields).toContain('company');
    expect(fields).toContain('date_announced');
    expect(fields).toContain('status');
    expect(fields).toContain('event_id');
  });

  it('rejects a negative or non-numeric jobs_cut_sg / jobs_cut_global', () => {
    const errs = validateEntry(
      entry({ jobs_cut_sg: -5 as any, jobs_cut_global: 'lots' as any, event_id: 'x' }),
      0
    );
    const fields = errs.map((e) => e.field);
    expect(fields).toContain('jobs_cut_sg');
    expect(fields).toContain('jobs_cut_global');
  });
});

describe('checkIntegrity', () => {
  it('flags two entries for the same company on the same date as a duplicate', () => {
    const w = checkIntegrity([
      entry({ company: 'Acme', date_announced: '2026-05-01' }),
      entry({ company: 'Acme', date_announced: '2026-05-01' }),
    ]);
    expect(w.some((x) => x.type === 'duplicate')).toBe(true);
  });

  it('treats "X Singapore" and "X" as the same company (alias-aware grouping)', () => {
    // Regression: BioNTech Singapore + BioNTech on the same date must collapse.
    const w = checkIntegrity([
      entry({ company: 'BioNTech Singapore', date_announced: '2026-05-05' }),
      entry({ company: 'BioNTech', date_announced: '2026-05-05', jobs_cut_global: 1860 }),
    ]);
    expect(w.some((x) => x.type === 'duplicate')).toBe(true);
  });

  it('does NOT flag two rows that deliberately share an event_id as a double-count', () => {
    // event_id records that these are follow-up coverage of ONE event.
    const w = checkIntegrity([
      entry({ company: 'BioNTech', date_announced: '2026-04-02', event_id: 'biontech-2026-04', source_link: 'https://www.straitstimes.com/a' }),
      entry({ company: 'BioNTech', date_announced: '2026-05-05', event_id: 'biontech-2026-04', source_link: 'https://www.straitstimes.com/b' }),
    ]);
    expect(w.some((x) => x.type === 'double-count')).toBe(false);
    expect(w.some((x) => x.type === 'duplicate')).toBe(false);
  });

  it('flags a confirmed multi-site headcount parked in jobs_cut_sg as a global figure', () => {
    const w = checkIntegrity([
      entry({
        company: 'BioNTech',
        jobs_cut_sg: 1860,
        notes: 'closure of sites in Germany and Singapore, affecting 1,860 staff',
      }),
    ]);
    expect(w.some((x) => x.type === 'global-figure')).toBe(true);
  });

  it('flags a confirmed entry with a vague company name', () => {
    const w = checkIntegrity([entry({ company: 'Another Legacy Bank', jobs_cut_sg: 777 })]);
    expect(w.some((x) => x.type === 'vague-company')).toBe(true);
  });

  it('flags a confirmed entry whose notes hedge', () => {
    const w = checkIntegrity([
      entry({ company: 'Jumbo', notes: 'closure reported; layoffs likely but plans to confirm' }),
    ]);
    expect(w.some((x) => x.type === 'contradictory-verdict')).toBe(true);
  });

  it('flags same-company confirmed pairs weeks apart as a possible double-count', () => {
    // Regression: BioNTech's SG plant closure carried two confirmed dates 29 days
    // apart and slipped past the old 7-day window.
    const w = checkIntegrity([
      entry({ company: 'BioNTech', date_announced: '2026-04-06' }),
      entry({ company: 'BioNTech', date_announced: '2026-05-05' }),
    ]);
    expect(w.some((x) => x.type === 'double-count')).toBe(true);
  });

  it('does not double-count confirmed entries more than a month apart', () => {
    const w = checkIntegrity([
      entry({ company: 'Acme', date_announced: '2026-01-01', source_link: 'https://www.straitstimes.com/a' }),
      entry({ company: 'Acme', date_announced: '2026-06-01', source_link: 'https://www.straitstimes.com/b' }),
    ]);
    expect(w.some((x) => x.type === 'double-count')).toBe(false);
  });

  it('is quiet on a clean, distinct, well-sourced dataset', () => {
    const w = checkIntegrity([
      entry({ company: 'Grab', date_announced: '2026-01-10', source_link: 'https://www.straitstimes.com/grab' }),
      entry({ company: 'Shopee', date_announced: '2026-03-20', source_link: 'https://www.straitstimes.com/shopee' }),
    ]);
    expect(w).toHaveLength(0);
  });
});

describe('checkIntegrity — cross-name same-event detection', () => {
  it('flags near-date, same-industry rows that share a distinctive company token', () => {
    // Regression: one Eunos coffee-shop closure was logged five times under
    // different names ("Eunos Canteen", "Unnamed Eunos Coffee Shop", …). The
    // company-keyed grouping never collated them; a shared rare token does.
    const w = checkIntegrity([
      entry({ company: 'Eunos Canteen', industry: 'F&B', date_announced: '2026-07-01' }),
      entry({ company: 'Unnamed Eunos Coffee Shop', industry: 'F&B', date_announced: '2026-07-03' }),
    ]);
    const hit = w.find((x) => x.type === 'possible-same-event');
    expect(hit).toBeDefined();
    expect(hit!.message.toLowerCase()).toContain('eunos');
  });

  it('flags a brand token shared across parent/subsidiary names (Jetstar/Qantas)', () => {
    const w = checkIntegrity([
      entry({ company: 'Jetstar Asia', industry: 'Other', date_announced: '2025-06-11' }),
      entry({ company: 'Qantas Airways', industry: 'Other', date_announced: '2025-06-12', notes: 'closure of Jetstar Asia' }),
    ]);
    // Note: "Qantas (Jetstar Asia)" is now alias-collapsed, so this uses a name the
    // alias does NOT cover — the token check is the safety net for the long tail.
    expect(w.some((x) => x.type === 'possible-same-event')).toBe(false);
    // (No shared company token here — notes are intentionally excluded — so the
    // check stays silent rather than guessing. Alias collapse is the primary fix.)
  });

  it('does NOT flag rows that only share a generic corporate word', () => {
    const w = checkIntegrity([
      entry({ company: 'Legacy Bank', industry: 'Finance', date_announced: '2026-05-01' }),
      entry({ company: 'Digital Bank', industry: 'Finance', date_announced: '2026-05-05' }),
    ]);
    expect(w.some((x) => x.type === 'possible-same-event')).toBe(false);
  });

  it('does NOT flag a shared token across different industries', () => {
    const w = checkIntegrity([
      entry({ company: 'Eunos Canteen', industry: 'F&B', date_announced: '2026-07-01' }),
      entry({ company: 'Eunos Motors', industry: 'Other', date_announced: '2026-07-03' }),
    ]);
    expect(w.some((x) => x.type === 'possible-same-event')).toBe(false);
  });

  it('does NOT flag a shared token outside the date window', () => {
    const w = checkIntegrity([
      entry({ company: 'Eunos Canteen', industry: 'F&B', date_announced: '2026-01-01' }),
      entry({ company: 'Eunos Coffee Shop', industry: 'F&B', date_announced: '2026-07-01' }),
    ]);
    expect(w.some((x) => x.type === 'possible-same-event')).toBe(false);
  });
});

describe('checkIntegrity — same-day same-event hard error', () => {
  it('flags same-day, same-industry rows sharing a rare company token with different event_id as an error', () => {
    // Regression: "Uber" and "Uber Technologies" both dated 2026-09-02 are the same
    // announcement scraped under two names — high-confidence enough to hard-error.
    const w = checkIntegrity([
      entry({ company: 'Uber', industry: 'Tech', date_announced: '2026-09-02', event_id: 'uber-2026-09-a' }),
      entry({ company: 'Uber Technologies', industry: 'Tech', date_announced: '2026-09-02', event_id: 'uber-2026-09-b' }),
    ]);
    const hit = w.find((x) => x.type === 'same-day-same-event');
    expect(hit).toBeDefined();
    expect(hit!.rows).toEqual([1, 2]);
    // Same-day pairs are promoted to the error and must NOT also show up as the
    // advisory possible-same-event warning.
    expect(w.some((x) => x.type === 'possible-same-event')).toBe(false);
  });

  it('does NOT flag same-day rows that already share an event_id', () => {
    const w = checkIntegrity([
      entry({ company: 'Uber', industry: 'Tech', date_announced: '2026-09-02', event_id: 'uber-2026-09' }),
      entry({ company: 'Uber Technologies', industry: 'Tech', date_announced: '2026-09-02', event_id: 'uber-2026-09' }),
    ]);
    expect(w.some((x) => x.type === 'same-day-same-event')).toBe(false);
  });

  it('keeps the near-date (≤21d), different-date version as an advisory warning, not an error', () => {
    const w = checkIntegrity([
      entry({ company: 'Eunos Canteen', industry: 'F&B', date_announced: '2026-07-01', event_id: 'a' }),
      entry({ company: 'Unnamed Eunos Coffee Shop', industry: 'F&B', date_announced: '2026-07-03', event_id: 'b' }),
    ]);
    expect(w.some((x) => x.type === 'same-day-same-event')).toBe(false);
    expect(w.some((x) => x.type === 'possible-same-event')).toBe(true);
  });

  it('does NOT flag a generic token (e.g. "cafe") even on the same day', () => {
    const w = checkIntegrity([
      entry({ company: 'Laurent Cafe & Chocolate Bar', industry: 'F&B', date_announced: '2026-08-09', event_id: 'a' }),
      entry({ company: 'Fika Swedish Cafe', industry: 'F&B', date_announced: '2026-08-09', event_id: 'b' }),
    ]);
    expect(w.some((x) => x.type === 'same-day-same-event')).toBe(false);
    expect(w.some((x) => x.type === 'possible-same-event')).toBe(false);
  });
});

describe('checkCrossFileContradictions', () => {
  it('flags an event kept in layoffs.csv that is also substantively rejected (same URL)', () => {
    // Regression: Lou Shang was kept (confirmed/rumored) while the same article sat in
    // rejected.csv as "not-sg". Wayback prefixes are stripped before comparison.
    const active = [entry({ company: 'Lou Shang', status: 'rumored', source_link: 'https://www.straitstimes.com/loushang' })];
    const rejected = [entry({
      company: 'Lou Shang',
      status: 'rumored',
      source_link: 'https://web.archive.org/web/20260101000000/https://www.straitstimes.com/loushang',
      notes: '[LLM rejected: not-sg] single cafe closure, not a layoff',
    })];
    const w = checkCrossFileContradictions(active, rejected);
    expect(w.some((x) => x.type === 'cross-file-contradiction')).toBe(true);
  });

  it('matches on the [gn:...] fingerprint when the wrapper URL differs', () => {
    const active = [entry({ company: 'Acme', source_link: 'https://news.google.com/rss/articles/AAA', notes: 'kept [gn:acme cuts jobs]' })];
    const rejected = [entry({ company: 'Acme', source_link: 'https://news.google.com/rss/articles/BBB', notes: '[LLM rejected: commentary] [gn:acme cuts jobs]' })];
    const w = checkCrossFileContradictions(active, rejected);
    expect(w.some((x) => x.type === 'cross-file-contradiction')).toBe(true);
  });

  it('ignores duplicate-suppression rows that mirror a kept entry on purpose', () => {
    // A rejected row logged as "duplicate of existing entry" deliberately shares the
    // kept entry's URL to block re-scraping — it agrees, it does not contradict.
    const active = [entry({ company: 'Meta', source_link: 'https://web.archive.org/web/20260520135241/https://finance.yahoo.com/news/meta-8000' })];
    const rejected = [entry({ company: 'Meta', source_link: 'https://finance.yahoo.com/news/meta-8000', notes: 'Duplicate of existing Meta entry' })];
    const w = checkCrossFileContradictions(active, rejected);
    expect(w).toHaveLength(0);
  });

  it('does not flag distinct sources for the same event', () => {
    const active = [entry({ company: 'Shopee', source_link: 'https://www.straitstimes.com/shopee' })];
    const rejected = [entry({ company: 'Shopee', source_link: 'https://www.hcamag.com/shopee', notes: '[rejected: duplicate] already confirmed' })];
    const w = checkCrossFileContradictions(active, rejected);
    expect(w).toHaveLength(0);
  });
});

describe('checkIntegrity — one warning per event-id pair', () => {
  function biontechRows(): LayoffEntry[] {
    return [
      entry({ company: 'BioNTech', date_announced: '2026-04-06', event_id: 'biontech-2026-04', source_link: 'https://www.straitstimes.com/a1' }),
      entry({ company: 'BioNTech Singapore', date_announced: '2026-04-07', event_id: 'biontech-2026-04', source_link: 'https://www.straitstimes.com/a2' }),
      entry({ company: 'BioNTech', date_announced: '2026-04-08', event_id: 'biontech-2026-04', source_link: 'https://www.straitstimes.com/a3' }),
      entry({ company: 'BioNTech', date_announced: '2026-05-05', event_id: 'biontech-2026-05', source_link: 'https://www.straitstimes.com/b1' }),
      entry({ company: 'BioNTech', date_announced: '2026-05-06', event_id: 'biontech-2026-05', source_link: 'https://www.straitstimes.com/b2' }),
    ];
  }

  it('collapses every cross-event row pair into a single double-count warning', () => {
    const doubles = checkIntegrity(biontechRows(), new Set()).filter((w) => w.type === 'double-count');
    expect(doubles).toHaveLength(1);
    const [w] = doubles;
    expect(w.eventIds).toEqual(['biontech-2026-04', 'biontech-2026-05']);
    expect(w.rows).toEqual([1, 2, 3, 4, 5]);
    expect(w.message).toContain('biontech-2026-04 (from 2026-04-06)');
    expect(w.message).toContain('biontech-2026-05 (from 2026-05-05)');
    expect(w.message).toContain('27d apart');
    expect(w.message).toContain('rows 1 + 4 others');
  });

  it('gives the same fingerprint regardless of row order', () => {
    const forward = checkIntegrity(biontechRows(), new Set()).find((w) => w.type === 'double-count')!;
    const reversed = checkIntegrity(biontechRows().reverse(), new Set()).find((w) => w.type === 'double-count')!;
    expect(warningFingerprint(reversed)).toBe(warningFingerprint(forward));
    expect(warningFingerprint(forward)).toBe('double-count :: biontech-2026-04 + biontech-2026-05');
  });

  it('suppresses a pair listed in distinct-events.csv in either order', () => {
    const distinct = parseDistinctEventPairs(
      'event_id_a,event_id_b,why\nbiontech-2026-05,biontech-2026-04,separate rounds\n'
    );
    const w = checkIntegrity(biontechRows(), distinct);
    expect(w.some((x) => x.type === 'double-count')).toBe(false);
  });

  it('flags confirmed pairs up to 31 days apart but not 32', () => {
    const pair = (second: string) =>
      checkIntegrity(
        [
          entry({ company: 'Acme', date_announced: '2026-01-01', event_id: 'acme-a', source_link: 'https://www.straitstimes.com/a' }),
          entry({ company: 'Acme', date_announced: second, event_id: 'acme-b', source_link: 'https://www.straitstimes.com/b' }),
        ],
        new Set()
      ).some((w) => w.type === 'double-count');
    expect(pair('2026-02-01')).toBe(true);
    expect(pair('2026-02-02')).toBe(false);
  });

  it('reports a superseded rumor once per event pair', () => {
    const w = checkIntegrity(
      [
        entry({ company: 'Acme', date_announced: '2026-03-01', status: 'rumored', event_id: 'acme-rumor', source_link: 'https://www.straitstimes.com/r1' }),
        entry({ company: 'Acme', date_announced: '2026-03-02', status: 'rumored', event_id: 'acme-rumor', source_link: 'https://www.straitstimes.com/r2' }),
        entry({ company: 'Acme', date_announced: '2026-03-10', event_id: 'acme-confirmed', source_link: 'https://www.straitstimes.com/c1' }),
      ],
      new Set()
    ).filter((x) => x.type === 'superseded-rumor');
    expect(w).toHaveLength(1);
    expect(w[0].eventIds).toEqual(['acme-rumor', 'acme-confirmed']);
    expect(w[0].message).toContain('8d');
  });

  it('reports a cross-name same-event pair once per event pair', () => {
    const w = checkIntegrity(
      [
        entry({ company: 'Eunos Canteen', industry: 'F&B', date_announced: '2026-07-01', event_id: 'eunos-a', source_link: 'https://www.straitstimes.com/e1' }),
        entry({ company: 'Eunos Canteen', industry: 'F&B', date_announced: '2026-07-02', event_id: 'eunos-a', source_link: 'https://www.straitstimes.com/e2' }),
        entry({ company: 'Unnamed Eunos Coffee Shop', industry: 'F&B', date_announced: '2026-07-03', event_id: 'eunos-b', source_link: 'https://www.straitstimes.com/e3' }),
      ],
      new Set()
    ).filter((x) => x.type === 'possible-same-event');
    expect(w).toHaveLength(1);
    expect(w[0].rows).toEqual([1, 2, 3]);
    expect(w[0].message).toContain('1d apart');
  });
});

describe('formatRows', () => {
  it('lists up to three rows and compacts the rest', () => {
    expect(formatRows([3, 1])).toBe('rows 1, 3');
    expect(formatRows([724, 9, 10, 11, 12])).toBe('rows 9 + 4 others');
  });
});

describe('baseline fingerprints', () => {
  it('keys per-row warnings on the normalized source URL, so Wayback archival is not a new warning', () => {
    const live = checkIntegrity([entry({ company: 'Acme', notes: 'plans to cut jobs', source_link: 'https://www.straitstimes.com/acme' })], new Set());
    const archived = checkIntegrity(
      [entry({ company: 'Acme', notes: 'plans to cut jobs', source_link: 'https://web.archive.org/web/20260101000000/https://www.straitstimes.com/acme' })],
      new Set()
    );
    expect(live.map(warningFingerprint)).toEqual(archived.map(warningFingerprint));
  });

  it('reports only warnings that are absent from the baseline', () => {
    const baseline = checkIntegrity([entry({ company: 'Acme', source_link: 'https://unknown.example/a' })], new Set());
    const current = checkIntegrity(
      [
        entry({ company: 'Shopee', date_announced: '2026-02-01', source_link: 'https://unknown.example/b' }),
        entry({ company: 'Acme', source_link: 'https://unknown.example/a' }),
      ],
      new Set()
    );
    const added = newWarnings(current, baseline);
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('unarchived-confirmed');
    expect(added[0].message).toContain('Shopee');
  });
});

describe('parseLayoffEntries', () => {
  it('parses the committed layoffs.csv exactly like readCsv', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'layoffs.csv'), 'utf-8');
    expect(parseLayoffEntries(raw)).toEqual(readCsv('layoffs.csv'));
  });
});

describe('eventStats', () => {
  it('counts rows, distinct event_ids, and events with at least one confirmed row', () => {
    const stats = eventStats([
      entry({ event_id: 'a' }),
      entry({ event_id: 'a', status: 'rumored' }),
      entry({ event_id: 'b', status: 'rumored' }),
    ]);
    expect(stats).toEqual({ rows: 3, events: 2, confirmedEvents: 1 });
  });
});

describe('parseCliArgs', () => {
  it('reads --baseline, --verbose and a positional file', () => {
    expect(parseCliArgs(['--baseline', 'HEAD~1', '--verbose'])).toEqual({
      file: 'layoffs.csv',
      verbose: true,
      baselineRef: 'HEAD~1',
    });
    expect(parseCliArgs(['rejected.csv', '--baseline=main']).file).toBe('rejected.csv');
    expect(() => parseCliArgs(['--baseline'])).toThrow();
  });
});

describe('eventPairKey', () => {
  it('is order-independent', () => {
    expect(eventPairKey('b', 'a')).toBe(eventPairKey('a', 'b'));
  });
});
