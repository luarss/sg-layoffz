'use client';

import dynamic from 'next/dynamic';
import type { BenchmarkComparisonRow } from '@/lib/momBenchmark';
import { safeHttpUrl } from '@/lib/safeUrl';

const MomBenchmarkChart = dynamic(() => import('./MomBenchmarkChart'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

function ChartSkeleton() {
  return (
    <div className="animate-pulse bg-gray-50 h-64 flex items-center justify-center">
      <span className="text-gray-600 text-sm">Loading chart...</span>
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
    <section className="border-t border-gray-200 pt-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-1">
        Coverage vs. MOM Official Retrenchments
      </h3>
      <p className="max-w-prose text-xs text-gray-500 mb-6">
        How this tracker&apos;s recorded job cuts compare with the Ministry of Manpower&apos;s
        official quarterly retrenchment figures.
      </p>

      {latest && (
        <p className="max-w-prose text-sm text-gray-700 mb-8">
          This tracker captured{' '}
          <span className="font-semibold text-gray-900">
            {latest.coveragePct.toFixed(1)}%
          </span>{' '}
          of the {latest.momRetrenchments.toLocaleString()} retrenchments officially reported by
          MOM in {quarterHeading(latest.quarter)} ({latest.trackerJobs.toLocaleString()} jobs across{' '}
          {latest.trackerCount} {latest.trackerCount === 1 ? 'event' : 'events'}).
        </p>
      )}

      <div className="mb-10">
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
                  <span className="text-gray-600"> ({row.trackerCount})</span>
                </td>
                <td className="py-2 pr-4 text-right text-gray-700">
                  {row.momRetrenchments.toLocaleString()}
                </td>
                <td className="py-2 pr-4 text-right font-medium text-gray-900">
                  {row.coveragePct.toFixed(1)}%
                </td>
                <td className="py-2">
                  <a
                    href={safeHttpUrl(row.source_url)}
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

      <div className="mt-6 max-w-prose text-xs text-gray-600 leading-relaxed">
        <p className="font-medium text-gray-900">
          These numbers are indicative of coverage, not an exact like-for-like comparison.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            MOM counts <em>all</em> retrenchments across the economy, including small and unreported
            ones. This tracker only records layoffs publicly reported in the news, so its figures
            should normally sit well below the official numbers.
          </li>
          <li>
            A quarter can occasionally exceed 100% coverage. The tracker logs the total headcount a
            company announced, which may include roles outside Singapore or span multiple quarters.
            MOM counts only Singapore-based retrenchments, in the quarter they occur.
          </li>
        </ul>
      </div>
    </section>
  );
}
