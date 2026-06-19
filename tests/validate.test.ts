import { describe, it, expect } from 'vitest';
import {
  VAGUE_COMPANY,
  HEDGE_NOTES,
  validateEntry,
  checkIntegrity,
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

  it('is quiet on a clean, distinct, well-sourced dataset', () => {
    const w = checkIntegrity([
      entry({ company: 'Grab', date_announced: '2026-01-10', source_link: 'https://www.straitstimes.com/grab' }),
      entry({ company: 'Shopee', date_announced: '2026-03-20', source_link: 'https://www.straitstimes.com/shopee' }),
    ]);
    expect(w).toHaveLength(0);
  });
});
