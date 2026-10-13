import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LayoffEntry, ReviewEntry } from '../src/lib/types';
import { SearchHit } from '../scripts/search';

const csvFiles = vi.hoisted(() => ({
  data: {} as Record<string, unknown[]>,
  appended: [] as Array<{ filename: string; entries: unknown[] }>,
}));

vi.mock('../src/lib/csv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/csv')>()),
  readCsv: (filename: string) => csvFiles.data[filename] ?? [],
  appendCsv: (filename: string, entries: unknown[]) => {
    csvFiles.appended.push({ filename, entries });
  },
}));

import {
  dedupeHits,
  hitToReviewEntry,
  ingestCandidates,
  POTENTIAL_DUPLICATE_NOTE,
} from '../scripts/scrape-common';

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    title: 'Acme cuts 120 jobs in Singapore - The Straits Times',
    url: 'https://example.com/acme',
    snippet: 'Acme said it will cut 120 jobs.',
    publishedDate: '2026-05-04',
    source: 'Straits Times',
    ...over,
  };
}

function layoff(over: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'Grab',
    date_announced: '2026-05-01',
    date_reported: '2026-05-01',
    jobs_cut_sg: null,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Tech',
    source_link: 'https://existing.com/grab',
    notes: '',
    status: 'confirmed',
    event_id: 'grab-2026-05',
    ...over,
  };
}

function candidate(over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    ...layoff({ status: 'rumored', event_id: '' }),
    review_id: 'r1',
    candidate_urls: '',
    snippet: '',
    ...over,
  };
}

describe('hitToReviewEntry', () => {
  it('formats a Google News entry with a bare timestamp id and bare fingerprint note', () => {
    const entry = hitToReviewEntry(hit(), 3);
    expect(entry.review_id).toMatch(/^\d+-3$/);
    expect(entry.notes).toBe('[gn:acme cuts 120 jobs in singapore]');
    expect(entry.company).toBe('Acme');
    expect(entry.date_announced).toBe('2026-05-04');
    expect(entry.date_reported).toBe('2026-05-04');
    expect(entry.jobs_cut_sg).toBe(120);
    expect(entry.status).toBe('rumored');
    expect(entry.event_id).toBe('');
    expect(entry.candidate_urls).toBe('https://example.com/acme');
  });

  it('formats an RSS feed entry with the src prefix and feed name', () => {
    const entry = hitToReviewEntry(hit(), 0, { idPrefix: 'src', notesPrefix: 'From Mothership' });
    expect(entry.review_id).toMatch(/^src-\d+-0$/);
    expect(entry.notes).toBe('From Mothership [gn:acme cuts 120 jobs in singapore]');
  });

  it('formats an Exa entry with the exa prefix', () => {
    const entry = hitToReviewEntry(hit(), 7, { idPrefix: 'exa', notesPrefix: 'From Exa' });
    expect(entry.review_id).toMatch(/^exa-\d+-7$/);
    expect(entry.notes).toBe('From Exa [gn:acme cuts 120 jobs in singapore]');
  });

  it('falls back to the URL for a missing title and today for a missing date', () => {
    const entry = hitToReviewEntry(hit({ title: '', publishedDate: '', snippet: 'x'.repeat(400) }), 0);
    expect(entry.date_announced).toBe(new Date().toISOString().slice(0, 10));
    expect(entry.notes).toBe('[gn:https example com acme]');
    expect(entry.snippet).toHaveLength(300);
  });
});

describe('dedupeHits', () => {
  it('drops repeated URLs and repeated title fingerprints', () => {
    const hits = [
      hit({ url: 'https://a.com/1', title: 'Acme cuts 120 jobs in Singapore today - CNA' }),
      hit({ url: 'https://a.com/1', title: 'Totally different headline' }),
      hit({ url: 'https://b.com/2', title: 'Acme cuts 120 jobs in Singapore today - ST' }),
      hit({ url: 'https://c.com/3', title: 'Beta shuts office' }),
    ];
    expect(dedupeHits(hits).map((h) => h.url)).toEqual(['https://a.com/1', 'https://c.com/3']);
  });

  it('drops hits without a URL and keeps hits whose fingerprint is empty', () => {
    const hits = [hit({ url: '' }), hit({ url: 'https://a.com/1', title: '!!!' }), hit({ url: 'https://a.com/2', title: '???' })];
    expect(dedupeHits(hits).map((h) => h.url)).toEqual(['https://a.com/1', 'https://a.com/2']);
  });
});

describe('ingestCandidates', () => {
  let logs: string[];

  beforeEach(() => {
    csvFiles.data = {
      'layoffs.csv': [layoff()],
      'review-queue.csv': [candidate({ company: 'Shopee', date_announced: '2026-06-10', source_link: 'https://q.com/a', notes: '[gn:queued fp]' })],
      'rejected.csv': [layoff({ company: 'Noise', source_link: 'https://rejected.com/x' })],
    };
    csvFiles.appended = [];
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies new, duplicate and potential-duplicate outcomes and prints SCRAPE_RESULT', () => {
    const entries = [
      candidate({ company: 'Zalora', date_announced: '2026-09-01', source_link: 'https://new.com/zalora', notes: '[gn:zalora]' }),
      candidate({ company: 'Other', date_announced: '2026-09-02', source_link: 'https://rejected.com/x', notes: '[gn:other]' }),
      candidate({ company: 'Another', date_announced: '2026-09-03', source_link: 'https://new.com/another', notes: '[gn:queued fp]' }),
      candidate({ company: 'Grab', date_announced: '2026-05-20', source_link: 'https://new.com/grab', notes: '[gn:grab]' }),
      candidate({ company: 'Zalora', date_announced: '2026-09-01', source_link: 'https://new.com/zalora-2', notes: '[gn:zalora two]' }),
    ];

    const counts = ingestCandidates('google_news', entries, 2);

    expect(counts).toEqual({ newEntries: 2, duplicates: 5, potentialDupes: 1 });
    expect(csvFiles.appended).toHaveLength(1);
    expect(csvFiles.appended[0].filename).toBe('review-queue.csv');
    const written = csvFiles.appended[0].entries as ReviewEntry[];
    expect(written.map((e) => e.source_link)).toEqual(['https://new.com/zalora', 'https://new.com/grab']);
    expect(written[1].notes).toBe(`[gn:grab] | ${POTENTIAL_DUPLICATE_NOTE}`);
    expect(logs).toContain('SCRAPE_RESULT:source=google_news,new_entries=2,duplicates=5,potential_dupes=1');
  });

  it('skips the queue write when nothing is new', () => {
    const counts = ingestCandidates('exa', [candidate({ source_link: 'https://existing.com/grab' })]);
    expect(counts).toEqual({ newEntries: 0, duplicates: 1, potentialDupes: 0 });
    expect(csvFiles.appended).toHaveLength(0);
    expect(logs).toContain('  No new entries to add');
    expect(logs[logs.length - 1]).toBe('SCRAPE_RESULT:source=exa,new_entries=0,duplicates=1,potential_dupes=0');
  });

  it('keys the within-run skip on companyKey so aliased names collapse', () => {
    const entries = [
      candidate({ company: 'Acme Pte Ltd', date_announced: '2026-09-01', source_link: 'https://new.com/1', notes: '' }),
      candidate({ company: 'acme pte. ltd.', date_announced: '2026-09-01', source_link: 'https://new.com/2', notes: '' }),
    ];
    const counts = ingestCandidates('layoffsg', entries);
    expect(counts.newEntries).toBe(1);
    expect(counts.duplicates).toBe(1);
  });
});
