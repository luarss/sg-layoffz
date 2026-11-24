import { describe, it, expect } from 'vitest';
import {
  describeIndustries,
  describeMonthlyEvents,
  describeMonthlyJobs,
  findAxisCap,
  formatMonthLabel,
  niceCeiling,
  sortIndustriesByJobs,
} from '../src/lib/chartData';

describe('formatMonthLabel', () => {
  it('renders short month and two-digit year', () => {
    expect(formatMonthLabel('2026-09')).toBe('Sep 26');
  });
});

describe('niceCeiling', () => {
  it('rounds up to the nearest half order of magnitude', () => {
    expect(niceCeiling(4200)).toBe(4500);
    expect(niceCeiling(5625)).toBe(6000);
    expect(niceCeiling(1800)).toBe(2000);
    expect(niceCeiling(2100)).toBe(2500);
    expect(niceCeiling(1000)).toBe(1000);
  });
});

describe('findAxisCap', () => {
  it('caps the axis when one value dwarfs the rest', () => {
    expect(findAxisCap([31000, 3200, 1500, 800])).toBe(4000);
  });

  it('leaves the axis alone when values are comparable', () => {
    expect(findAxisCap([3000, 2500, 1200])).toBeNull();
  });

  it('leaves the axis alone with fewer than two non-zero values', () => {
    expect(findAxisCap([5000])).toBeNull();
    expect(findAxisCap([5000, 0])).toBeNull();
  });

  it('keeps every value but the outlier below the cap', () => {
    const values = [31000, 4800, 900];
    const cap = findAxisCap(values)!;
    expect(values.filter((value) => value > cap)).toEqual([31000]);
  });
});

describe('chart summaries', () => {
  const months = [
    { month: '2026-08', jobs: 500, count: 3, rumoredCount: 1 },
    { month: '2026-09', jobs: 31000, count: 5, rumoredCount: 0 },
  ];

  it('names the peak month and range for jobs', () => {
    expect(describeMonthlyJobs(months)).toContain('Aug 26 to Sep 26');
    expect(describeMonthlyJobs(months)).toContain('Sep 26 with 31,000 jobs');
  });

  it('names both statuses for events', () => {
    const summary = describeMonthlyEvents(months);
    expect(summary).toContain('8 confirmed events');
    expect(summary).toContain('1 rumored event');
  });

  it('lists industries largest first', () => {
    const industries = [
      { industry: 'Retail', jobs: 100, count: 2 },
      { industry: 'Tech', jobs: 900, count: 9 },
    ];
    expect(sortIndustriesByJobs(industries).map((row) => row.industry)).toEqual(['Tech', 'Retail']);
    expect(describeIndustries(industries)).toContain('Tech 900, Retail 100');
  });
});
