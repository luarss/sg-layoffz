import fs from 'node:fs';
import Papa from 'papaparse';
import { AggregateStats } from './types';

/** One row of MOM's official quarterly retrenchment statistics. */
export interface MomBenchmarkRow {
  quarter: string; // e.g. "2026-Q1"
  retrenchments: number;
  source_url: string;
  notes: string;
}

/** The tracker's own jobs/events rolled up to a single quarter. */
export interface QuarterlyTrackerTotal {
  quarter: string; // "YYYY-Qn"
  jobs: number;
  count: number;
}

/** A joined row comparing the tracker against MOM for one quarter. */
export interface BenchmarkComparisonRow {
  quarter: string;
  trackerJobs: number;
  trackerCount: number;
  momRetrenchments: number;
  /** Tracker jobs as a percentage of MOM's official figure (0 when MOM figure is 0/absent). */
  coveragePct: number;
  source_url: string;
  notes: string;
}

// The monthlyBreakdown interface is guaranteed stable; alias it for readability.
type MonthlyBreakdown = AggregateStats['monthlyBreakdown'];

/**
 * Convert a "YYYY-MM" month key to a "YYYY-Qn" quarter key.
 * Returns null for anything that does not look like a valid month key.
 */
function monthToQuarter(month: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = match[1];
  const m = parseInt(match[2], 10);
  if (m < 1 || m > 12) return null;
  const quarter = Math.floor((m - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

/**
 * Aggregate the tracker's monthly stats into quarterly totals.
 *
 * Consumes ONLY the AggregateStats.monthlyBreakdown shape so it stays decoupled
 * from the underlying CSV schema. `jobs` are summed from confirmed events and
 * `count` is the number of confirmed events per quarter (matching computeStats).
 * Result is sorted ascending by quarter.
 */
export function aggregateMonthlyToQuarterly(monthly: MonthlyBreakdown): QuarterlyTrackerTotal[] {
  const byQuarter: Record<string, QuarterlyTrackerTotal> = {};

  for (const entry of monthly) {
    const quarter = monthToQuarter(entry.month);
    if (!quarter) continue;
    if (!byQuarter[quarter]) byQuarter[quarter] = { quarter, jobs: 0, count: 0 };
    byQuarter[quarter].jobs += entry.jobs;
    byQuarter[quarter].count += entry.count;
  }

  return Object.values(byQuarter).sort((a, b) => a.quarter.localeCompare(b.quarter));
}

/**
 * Join the tracker's quarterly totals against the MOM benchmark.
 *
 * Iterates over the MOM rows (the ground truth) so the comparison only ever
 * shows quarters with an official published figure. Quarters where the tracker
 * has no data show 0 jobs / 0% coverage.
 */
export function buildBenchmarkComparison(
  monthly: MonthlyBreakdown,
  benchmark: MomBenchmarkRow[]
): BenchmarkComparisonRow[] {
  const trackerByQuarter: Record<string, QuarterlyTrackerTotal> = {};
  for (const q of aggregateMonthlyToQuarterly(monthly)) {
    trackerByQuarter[q.quarter] = q;
  }

  return [...benchmark]
    .sort((a, b) => a.quarter.localeCompare(b.quarter))
    .map((row) => {
      const tracker = trackerByQuarter[row.quarter];
      const trackerJobs = tracker?.jobs ?? 0;
      const trackerCount = tracker?.count ?? 0;
      const coveragePct =
        row.retrenchments > 0 ? (trackerJobs / row.retrenchments) * 100 : 0;
      return {
        quarter: row.quarter,
        trackerJobs,
        trackerCount,
        momRetrenchments: row.retrenchments,
        coveragePct,
        source_url: row.source_url,
        notes: row.notes,
      };
    });
}

/**
 * Load MOM's official quarterly retrenchment benchmark from data/mom-benchmark.csv.
 * Returns [] if the file is missing.
 */
export function loadMomBenchmark(): MomBenchmarkRow[] {
  const filePath = `${process.cwd()}/data/mom-benchmark.csv`;
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    console.warn('MOM benchmark parse warnings:', parsed.errors);
  }

  return parsed.data
    .filter((row) => row.quarter && row.retrenchments)
    .map((row) => ({
      quarter: String(row.quarter).trim(),
      retrenchments: parseInt(String(row.retrenchments).replace(/[^0-9]/g, ''), 10) || 0,
      source_url: String(row.source_url ?? '').trim(),
      notes: String(row.notes ?? '').trim(),
    }));
}
