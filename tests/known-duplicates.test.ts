import { describe, it, expect } from 'vitest';
import { companyKey, normalizeCompany } from '../scripts/normalize';
import { checkIntegrity, eventPairKey } from '../scripts/validate';
import { LayoffEntry } from '../src/lib/types';
import knownDuplicatePairs from './fixtures/known-duplicate-pairs.json';

// This fixture (tests/fixtures/known-duplicate-pairs.json) is the regression log for
// every real-world "one event, two surface names" bug found in layoffs.csv or
// rejected.csv. Whenever a future audit merges two company-name variants (by adding an
// alias to data/company-aliases.csv, or by widening a generic-descriptor/unicode rule
// in scripts/normalize.ts), APPEND the pair here — don't just fix the data. That keeps
// the fix from silently regressing the next time normalizeCompany's rules change.
//
// known-distinct-pairs below is the companion list: names that look similar but name
// genuinely different companies, and must never collapse to the same key.

interface DuplicatePair {
  a: string;
  b: string;
  why: string;
}

const knownDistinctPairs: DuplicatePair[] = [
  {
    a: 'Pantler Patisserie',
    b: 'Flor Patisserie',
    why: 'Both are patisseries (shared trailing descriptor) but different base names.',
  },
  {
    a: 'Laurent Cafe & Chocolate Bar',
    b: 'Fika Swedish Cafe',
    why: 'Both are cafes but different base names — "cafe" must not be treated as identity.',
  },
  {
    a: 'Korea Artiz Studio',
    b: 'Korean Wedding Studio',
    why: 'Both are studios but different base names — "studio" must not be treated as identity.',
  },
  {
    a: 'Sea',
    b: 'Shopee',
    why: 'Sea Limited and its Shopee subsidiary are distinct brands for dedup purposes outside the pinned parenthetical forms.',
  },
  {
    a: 'Grab',
    b: 'GXS Bank',
    why: 'Grab co-owns GXS Bank, but they are separate, independently-tracked entities.',
  },
  {
    a: 'Japan Home',
    b: 'Japan',
    why: 'The trailing-descriptor strip must never eat into "Japan Home" and leave the country name alone.',
  },
  {
    a: 'Tiger Beer',
    b: 'Tiger',
    why: '"Beer" is deliberately excluded from the generic-descriptor list — must not strip to "Tiger".',
  },
  {
    a: 'Grab',
    b: 'Shopee',
    why: 'Baseline: unrelated companies must never collapse.',
  },
  {
    a: 'Uber',
    b: 'Uber Technologies',
    why: 'Live production pair, but deliberately left UNMERGED here: scripts/validate.ts\'s ' +
      'cross-name token check (see the "same-day-same-event" hard error in checkIntegrity) ' +
      'uses exactly this pair as its regression example for a same-day, same-industry, ' +
      'shared-token safety net. Merging it via normalizeCompany would route the pair through ' +
      'the same-company "duplicate" path instead and silently defeat that check — so no ' +
      '"technologies"/"technology"/"tech" trailing-descriptor rule was added.',
  },
];

describe('normalizeCompany — known duplicate pairs (regression fixture)', () => {
  for (const { a, b, why } of knownDuplicatePairs as DuplicatePair[]) {
    it(`collapses "${a}" and "${b}" to the same key (${why})`, () => {
      expect(companyKey(a)).toBe(companyKey(b));
    });
  }
});

function row(company: string, date: string, eventId: string, slug: string): LayoffEntry {
  return {
    company,
    date_announced: date,
    date_reported: date,
    jobs_cut_sg: null,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Other',
    source_link: `https://www.straitstimes.com/${slug}`,
    notes: '',
    status: 'confirmed',
    event_id: eventId,
  };
}

describe('checkIntegrity — known duplicate pairs under separate event_ids', () => {
  for (const { a, b } of knownDuplicatePairs as DuplicatePair[]) {
    it(`reports "${a}" / "${b}" as one event-pair double-count`, () => {
      const warnings = checkIntegrity(
        [
          row(a, '2026-05-01', 'event-a', 'a1'),
          row(a, '2026-05-02', 'event-a', 'a2'),
          row(b, '2026-05-10', 'event-b', 'b1'),
          row(b, '2026-05-11', 'event-b', 'b2'),
        ],
        new Set()
      );
      const doubles = warnings.filter((w) => w.type === 'double-count');
      expect(doubles).toHaveLength(1);
      expect(doubles[0].eventIds).toEqual(['event-a', 'event-b']);
      expect(doubles[0].rows).toEqual([1, 2, 3, 4]);
    });
  }

  it('stays quiet once the pair is recorded as distinct', () => {
    const [{ a, b }] = knownDuplicatePairs as DuplicatePair[];
    const warnings = checkIntegrity(
      [row(a, '2026-05-01', 'event-a', 'a1'), row(b, '2026-05-10', 'event-b', 'b1')],
      new Set([eventPairKey('event-b', 'event-a')])
    );
    expect(warnings.some((w) => w.type === 'double-count')).toBe(false);
  });
});

describe('normalizeCompany — known distinct pairs (must never merge)', () => {
  for (const { a, b, why } of knownDistinctPairs) {
    it(`keeps "${a}" and "${b}" as different keys (${why})`, () => {
      expect(companyKey(a)).not.toBe(companyKey(b));
    });
  }

  it('does not empty out or over-strip a bare generic-looking name', () => {
    expect(normalizeCompany('Sea')).toBe('Sea');
    expect(normalizeCompany('Cafe')).toBe('Cafe');
  });
});
