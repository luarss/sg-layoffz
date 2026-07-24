import { describe, it, expect } from 'vitest';
import {
  aggregateMonthlyToQuarterly,
  buildBenchmarkComparison,
  MomBenchmarkRow,
} from '../src/lib/momBenchmark';

type Monthly = { month: string; jobs: number; count: number; rumoredCount: number };

function m(month: string, jobs: number, count: number): Monthly {
  return { month, jobs, count, rumoredCount: 0 };
}

describe('aggregateMonthlyToQuarterly', () => {
  it('groups months into the correct quarters and sums jobs + counts', () => {
    const monthly: Monthly[] = [
      m('2026-01', 100, 2),
      m('2026-02', 50, 1),
      m('2026-03', 30, 1),
      m('2026-04', 200, 3),
    ];
    const result = aggregateMonthlyToQuarterly(monthly);
    expect(result).toEqual([
      { quarter: '2026-Q1', jobs: 180, count: 4 },
      { quarter: '2026-Q2', jobs: 200, count: 3 },
    ]);
  });

  it('maps each month to the right quarter boundary', () => {
    const monthly: Monthly[] = [
      m('2025-03', 1, 1), // Q1
      m('2025-06', 1, 1), // Q2
      m('2025-09', 1, 1), // Q3
      m('2025-12', 1, 1), // Q4
    ];
    const quarters = aggregateMonthlyToQuarterly(monthly).map((q) => q.quarter);
    expect(quarters).toEqual(['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4']);
  });

  it('returns results sorted ascending by quarter regardless of input order', () => {
    const monthly: Monthly[] = [m('2026-01', 10, 1), m('2025-10', 5, 1), m('2025-01', 3, 1)];
    const quarters = aggregateMonthlyToQuarterly(monthly).map((q) => q.quarter);
    expect(quarters).toEqual(['2025-Q1', '2025-Q4', '2026-Q1']);
  });

  it('ignores malformed month keys', () => {
    const monthly: Monthly[] = [m('not-a-date', 999, 9), m('2026-13', 999, 9), m('2026-02', 20, 2)];
    expect(aggregateMonthlyToQuarterly(monthly)).toEqual([
      { quarter: '2026-Q1', jobs: 20, count: 2 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(aggregateMonthlyToQuarterly([])).toEqual([]);
  });
});

describe('buildBenchmarkComparison', () => {
  const benchmark: MomBenchmarkRow[] = [
    { quarter: '2026-Q1', retrenchments: 4000, source_url: 'https://mom/1', notes: 'a' },
    { quarter: '2025-Q4', retrenchments: 2000, source_url: 'https://mom/2', notes: 'b' },
  ];

  it('joins tracker totals to MOM figures and computes coverage %', () => {
    const monthly: Monthly[] = [m('2026-01', 1000, 3), m('2025-12', 100, 1)];
    const rows = buildBenchmarkComparison(monthly, benchmark);
    // sorted ascending by quarter
    expect(rows.map((r) => r.quarter)).toEqual(['2025-Q4', '2026-Q1']);
    expect(rows[0]).toMatchObject({ trackerJobs: 100, momRetrenchments: 2000, coveragePct: 5 });
    expect(rows[1]).toMatchObject({ trackerJobs: 1000, momRetrenchments: 4000, coveragePct: 25 });
  });

  it('shows 0 coverage for a benchmark quarter with no tracker data', () => {
    const rows = buildBenchmarkComparison([], benchmark);
    expect(rows.every((r) => r.trackerJobs === 0 && r.coveragePct === 0)).toBe(true);
  });
});
