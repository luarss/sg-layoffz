import { describe, it, expect } from 'vitest';
import {
  isDuplicate,
  isDuplicateIndexed,
  buildDedupIndex,
  extractGnFingerprint,
  DedupCandidate,
} from '../scripts/deduplicate';
import { LayoffEntry, ReviewEntry } from '../src/lib/types';

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

function review(over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    ...entry(),
    review_id: 'r1',
    candidate_urls: '',
    snippet: '',
    ...over,
  };
}

describe('extractGnFingerprint', () => {
  it('extracts the [gn:...] token', () => {
    expect(extractGnFingerprint('headline [gn:abc123] more')).toBe('abc123');
  });
  it('returns null when no fingerprint is present', () => {
    expect(extractGnFingerprint('no fingerprint here')).toBeNull();
  });
});

describe('isDuplicate', () => {
  it('matches an exact source URL case-insensitively', () => {
    const existing = [entry({ source_link: 'https://x.com/article' })];
    expect(
      isDuplicate({ source_link: 'https://X.com/Article' }, existing, [])
    ).toBe('duplicate');
  });

  it('matches a URL differing only by utm tracking params', () => {
    const existing = [entry({ source_link: 'https://x.com/article' })];
    expect(
      isDuplicate(
        { source_link: 'https://x.com/article?utm_source=twitter&utm_medium=social' },
        existing,
        []
      )
    ).toBe('duplicate');
  });

  it('matches a URL differing only by a trailing slash', () => {
    const existing = [entry({ source_link: 'https://x.com/article' })];
    expect(
      isDuplicate({ source_link: 'https://x.com/article/' }, existing, [])
    ).toBe('duplicate');
  });

  it('matches a URL differing only by http vs https scheme', () => {
    const existing = [entry({ source_link: 'https://x.com/article' })];
    expect(
      isDuplicate({ source_link: 'http://x.com/article' }, existing, [])
    ).toBe('duplicate');
  });

  it('matches a URL differing only by a www prefix', () => {
    const existing = [entry({ source_link: 'https://x.com/article' })];
    expect(
      isDuplicate({ source_link: 'https://www.x.com/article' }, existing, [])
    ).toBe('duplicate');
  });

  it('matches a Wayback-wrapped variant of an existing source_link', () => {
    const existing = [entry({ source_link: 'https://x.com/article' })];
    expect(
      isDuplicate(
        { source_link: 'https://web.archive.org/web/20260101000000/https://x.com/article' },
        existing,
        []
      )
    ).toBe('duplicate');
  });

  it('matches a URL differing only by utm params against rejected.csv', () => {
    const rejected = [entry({ source_link: 'https://x.com/rejected' })];
    expect(
      isDuplicate(
        { source_link: 'https://x.com/rejected?utm_source=newsletter' },
        [],
        [],
        rejected
      )
    ).toBe('duplicate');
  });

  it('matches a Google News fingerprint already in the review queue', () => {
    const queue = [review({ notes: 'title [gn:fp-9] x' })];
    expect(
      isDuplicate({ notes: 'other wrapper [gn:fp-9]' }, [], queue)
    ).toBe('duplicate');
  });

  it('does not let a rejected article re-surface (URL in rejected.csv)', () => {
    const rejected = [entry({ source_link: 'https://x.com/rejected' })];
    expect(
      isDuplicate({ source_link: 'https://x.com/rejected' }, [], [], rejected)
    ).toBe('duplicate');
  });

  it('treats a Google News entry with same company+date as a duplicate', () => {
    const existing = [entry({ company: 'Grab', date_announced: '2026-05-01' })];
    expect(
      isDuplicate(
        {
          source_link: 'https://news.google.com/rss/articles/XYZ',
          company: 'Grab',
          date_announced: '2026-05-01',
        },
        existing,
        []
      )
    ).toBe('duplicate');
  });

  it('flags same company + same month as a potential duplicate', () => {
    const existing = [entry({ company: 'Grab', date_announced: '2026-05-01' })];
    expect(
      isDuplicate(
        { company: 'Grab', date_announced: '2026-05-20', source_link: 'https://other.com/x' },
        existing,
        []
      )
    ).toBe('potential-duplicate');
  });

  it('returns "new" for an unrelated candidate', () => {
    const existing = [entry({ company: 'Grab', date_announced: '2026-05-01' })];
    expect(
      isDuplicate(
        { company: 'Zalora', date_announced: '2026-09-01', source_link: 'https://new.com/x' },
        existing,
        []
      )
    ).toBe('new');
  });
});

describe('isDuplicateIndexed', () => {
  const existing = [
    entry({ company: 'Grab', date_announced: '2026-05-01', source_link: 'https://x.com/article' }),
  ];
  const queue = [
    review({ company: 'Shopee', date_announced: '2026-06-10', source_link: 'https://q.com/a', notes: 'title [gn:fp-9] x' }),
  ];
  const rejected = [
    entry({ company: 'Lazada', date_announced: '2026-07-02', source_link: 'https://x.com/rejected', notes: '[gn:fp-rej]' }),
  ];

  const candidates: DedupCandidate[] = [
    { source_link: 'https://X.com/Article' },
    { source_link: 'https://x.com/article?utm_source=twitter' },
    { source_link: 'https://web.archive.org/web/20260101000000/https://x.com/article' },
    { source_link: 'https://x.com/rejected/' },
    { notes: 'other wrapper [gn:fp-9]' },
    { notes: '[gn:fp-rej]' },
    { source_link: 'https://news.google.com/rss/articles/XYZ', company: 'Grab', date_announced: '2026-05-01' },
    { source_link: 'https://news.google.com/rss/articles/ABC', company: 'Lazada', date_announced: '2026-07-02' },
    { source_link: 'https://other.com/lazada', company: 'Lazada', date_announced: '2026-07-02' },
    { company: 'Grab', date_announced: '2026-05-20', source_link: 'https://other.com/x' },
    { company: 'Shopee', date_announced: '2026-06-28', source_link: 'https://other.com/y' },
    { company: 'Zalora', date_announced: '2026-09-01', source_link: 'https://new.com/x' },
    {},
  ];

  it('agrees with isDuplicate on every fixture candidate', () => {
    const index = buildDedupIndex(existing, queue, rejected);
    for (const candidate of candidates) {
      expect(isDuplicateIndexed(candidate, index)).toBe(isDuplicate(candidate, existing, queue, rejected));
    }
  });

  it('covers all three outcomes across the fixtures', () => {
    const index = buildDedupIndex(existing, queue, rejected);
    const outcomes = new Set(candidates.map((candidate) => isDuplicateIndexed(candidate, index)));
    expect(outcomes).toEqual(new Set(['new', 'duplicate', 'potential-duplicate']));
  });

  it('does not flag a company-month match that only exists in rejected.csv', () => {
    const index = buildDedupIndex(existing, queue, rejected);
    expect(
      isDuplicateIndexed({ source_link: 'https://other.com/lazada', company: 'Lazada', date_announced: '2026-07-02' }, index)
    ).toBe('new');
  });
});
