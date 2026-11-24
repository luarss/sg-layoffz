'use client';

import dynamic from 'next/dynamic';
import { AggregateStats } from '@/lib/types';

const MonthlyBarChart = dynamic(() => import('./MonthlyBarChart'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

const IndustryBarChart = dynamic(() => import('./IndustryBarChart'), {
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

interface ChartsSectionProps {
  stats: AggregateStats;
}

export default function ChartsSection({ stats }: ChartsSectionProps) {
  if (stats.monthlyBreakdown.length === 0 && stats.industryBreakdown.length === 0) {
    return null;
  }

  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-16">
      <div className="border-t border-gray-200 pt-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-6">SG Jobs Cut by Month</h3>
        <MonthlyBarChart data={stats.monthlyBreakdown} metric="jobs" />
      </div>
      <div className="border-t border-gray-200 pt-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-6">Layoff Events by Month</h3>
        <MonthlyBarChart data={stats.monthlyBreakdown} metric="companies" />
      </div>
      <div className="border-t border-gray-200 pt-6 lg:col-span-2">
        <h3 className="text-sm font-semibold text-gray-900 mb-6">SG Jobs Cut by Industry</h3>
        <div className="max-w-2xl">
          <IndustryBarChart data={stats.industryBreakdown} />
        </div>
      </div>
    </section>
  );
}
