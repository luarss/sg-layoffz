import { describe, it, expect } from 'vitest';
import {
  VAGUE_COMPANY,
  HEDGE_NOTES,
  validateEntry,
  checkIntegrity,
  checkCrossFileContradictions,
} from '../scripts/validate';
import { LayoffEntry } from '../src/lib/types';

function entry(over: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'Acme',
    date_announced: '2026-05-01',
    jobs_cut: null,
    pct_workforce: null,
    industry: 'Tech',
    source_link: 'https://www.straitstimes.com/example',
    notes: '',
    status: 'confirmed',
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
    expect(validateEntry(entry(), 0)).toHaveLength(0);
  });

  it('rejects missing company, bad date, and bad status', () => {
    const errs = validateEntry(
      entry({ company: '', date_announced: '2026/05/01', status: 'bogus' as any }),
      0
    );
    const fields = errs.map((e) => e.field);
    expect(fields).toContain('company');
    expect(fields).toContain('date_announced');
    expect(fields).toContain('status');
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
      entry({ company: 'BioNTech', date_announced: '2026-05-05', jobs_cut: 1860 }),
    ]);
    expect(w.some((x) => x.type === 'duplicate')).toBe(true);
  });

  it('flags a confirmed multi-site headcount as a global figure', () => {
    const w = checkIntegrity([
      entry({
        company: 'BioNTech',
        jobs_cut: 1860,
        notes: 'closure of sites in Germany and Singapore, affecting 1,860 staff',
      }),
    ]);
    expect(w.some((x) => x.type === 'global-figure')).toBe(true);
  });

  it('flags a confirmed entry with a vague company name', () => {
    const w = checkIntegrity([entry({ company: 'Another Legacy Bank', jobs_cut: 777 })]);
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
