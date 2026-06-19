import { describe, it, expect } from 'vitest';
import {
  normalizeCompany,
  parseDate,
  extractJobsFromText,
  extractPctFromText,
  normalizeIndustry,
} from '../scripts/normalize';

// dedup keys are compared lowercased (see scripts/dedup-layoffs.ts and
// scripts/cluster.ts), so the contract these tests pin is that the normalized
// keys MATCH case-insensitively — not that the display casing is identical.
const key = (s: string) => normalizeCompany(s).toLowerCase();

describe('normalizeCompany — alias collapse (regression: split-event dedup bug)', () => {
  it('collapses "X Singapore" to the same key as "X" via suffix-stripping', () => {
    // The self-mapping aliases used to short-circuit suffix-stripping and split the
    // SG-office row from the parent-company row of the same event.
    expect(key('BioNTech Singapore')).toBe(key('BioNTech'));
    expect(key('ExxonMobil Singapore')).toBe(key('ExxonMobil'));
  });

  it('maps APB (Tiger Beer) to Heineken (same Tuas cut, two names)', () => {
    expect(normalizeCompany('APBs (Tiger Beer)')).toBe('Heineken');
    expect(key('APBs (Tiger Beer)')).toBe(key('Heineken'));
  });

  it('collapses the parenthetical "Yeo\'s (Yeo Hiap Seng)" form', () => {
    expect(normalizeCompany("Yeo's (Yeo Hiap Seng)")).toBe('Yeo Hiap Seng');
    expect(key("Yeo's (Yeo Hiap Seng)")).toBe(key('Yeo Hiap Seng'));
  });

  it('applies the simple alias table', () => {
    expect(normalizeCompany('DBS Bank')).toBe('DBS');
    expect(normalizeCompany('Citibank')).toBe('Citi');
    expect(normalizeCompany('Citigroup')).toBe('Citi');
  });

  it('strips corporate suffixes', () => {
    expect(key('Foo Pte Ltd')).toBe(key('Foo'));
    expect(key('Bar Holdings')).toBe(key('Bar'));
  });

  it('does not collapse genuinely distinct companies', () => {
    expect(key('DBS')).not.toBe(key('OCBC'));
    expect(key('Grab')).not.toBe(key('Shopee'));
  });
});

describe('parseDate', () => {
  it('passes through ISO dates unchanged', () => {
    expect(parseDate('2025-05-15')).toBe('2025-05-15');
  });

  it('parses textual dates to YYYY-MM-DD shape', () => {
    expect(parseDate('15 May 2025')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseDate('May 15, 2025')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns null for empty or unparseable input', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
  });
});

describe('extractJobsFromText', () => {
  it('pulls headcount from common phrasings', () => {
    expect(extractJobsFromText('the firm will cut 200 jobs')).toBe(200);
    expect(extractJobsFromText('laid off 1,860 employees worldwide')).toBe(1860);
    expect(extractJobsFromText('reduce its workforce by 300')).toBe(300);
  });

  it('returns null when no headcount is present', () => {
    expect(extractJobsFromText('the company is restructuring')).toBeNull();
  });
});

describe('extractPctFromText', () => {
  it('pulls a workforce percentage', () => {
    expect(extractPctFromText('cut 8% of its workforce')).toBe(8);
    expect(extractPctFromText('laid off 12.5% of staff')).toBe(12.5);
  });

  it('returns null when no percentage is present', () => {
    expect(extractPctFromText('the company is restructuring')).toBeNull();
  });
});

describe('normalizeIndustry', () => {
  it('maps synonyms to the canonical industry set', () => {
    expect(normalizeIndustry('technology')).toBe('Tech');
    expect(normalizeIndustry('banking')).toBe('Finance');
    expect(normalizeIndustry('logistics')).toBe('Other');
  });
});
