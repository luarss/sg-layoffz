'use client';

import dynamic from 'next/dynamic';
import type { BenchmarkComparisonRow } from '@/lib/momBenchmark';

const MomBenchmarkChart = dynamic(() => import('./MomBenchmarkChart'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

function ChartSkeleton() {
  return (
    <div className="animate-pulse bg-gray-100 rounded-lg h-64 flex items-center justify-center">
      <span className="text-gray-400 text-sm">Loading chart...</span>
    </div>
  );
}

interface MomBenchmarkProps {
  comparison: BenchmarkComparisonRow[];
}

function quarterHeading(quarter: string): string {
  const [year, q] = quarter.split('-');
  return `${q} ${year}`;
}

export default function MomBenchmark({ comparison }: MomBenchmarkProps) {
  if (comparison.length === 0) return null;

  const rows = comparison;
  const latest = rows[rows.length - 1];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-1">
        Coverage vs. MOM Official Retrenchments
      </h3>
      <p className="text-xs text-gray-500 mb-4">
        How this tracker&apos;s recorded job cuts compare with the Ministry of Manpower&apos;s
        official quarterly retrenchment figures.
      </p>

      {latest && (
        <p className="text-sm text-gray-700 mb-4">
          This tracker captured{' '}
          <span className="font-semibold text-gray-900">
            {latest.coveragePct.toFixed(1)}%
          </span>{' '}
          of the {latest.momRetrenchments.toLocaleString()} retrenchments officially reported by
          MOM in {quarterHeading(latest.quarter)} ({latest.trackerJobs.toLocaleString()} jobs across{' '}
          {latest.trackerCount} {latest.trackerCount === 1 ? 'event' : 'events'}).
        </p>
      )}

      <div className="mb-6">
        <MomBenchmarkChart data={rows} />
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-2 pr-4 font-medium">Quarter</th>
              <th className="py-2 pr-4 font-medium text-right">Tracker jobs</th>
              <th className="py-2 pr-4 font-medium text-right">MOM retrenchments</th>
              <th className="py-2 pr-4 font-medium text-right">Coverage</th>
              <th className="py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.quarter} className="border-b border-gray-100">
                <td className="py-2 pr-4 text-gray-900">{quarterHeading(row.quarter)}</td>
                <td className="py-2 pr-4 text-right text-gray-700">
                  {row.trackerJobs.toLocaleString()}
                  <span className="text-gray-400"> ({row.trackerCount})</span>
                </td>
                <td className="py-2 pr-4 text-right text-gray-700">
                  {row.momRetrenchments.toLocaleString()}
                </td>
                <td className="py-2 pr-4 text-right font-medium text-gray-900">
                  {row.coveragePct.toFixed(1)}%
                </td>
                <td className="py-2">
                  <a
                    href={row.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-900 underline"
                    title={row.notes}
                  >
                    MOM
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-gray-500 leading-relaxed">
        Caveat: MOM counts <em>all</em> retrenchments across the economy, including small and
        unreported ones, while this tracker only records layoffs that were publicly reported in the
        news. Tracker figures should therefore normally sit well below the official numbers.
        Occasionally a quarter can exceed 100% coverage because the tracker logs the total headcount
        announced by a company (which may include roles outside Singapore or span multiple quarters),
        whereas MOM counts only Singapore-based retrenchments in the quarter they occur. These
        numbers are indicative of coverage, not an exact like-for-like comparison.
      </p>
    </div>
  );
}
