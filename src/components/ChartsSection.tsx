'use client';

import dynamic from 'next/dynamic';
import { AggregateStats } from '@/lib/types';

const MonthlyBarChart = dynamic(() => import('./MonthlyBarChart'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

const IndustryPieChart = dynamic(() => import('./IndustryPieChart'), {
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

interface ChartsSectionProps {
  stats: AggregateStats;
}

export default function ChartsSection({ stats }: ChartsSectionProps) {
  if (stats.monthlyBreakdown.length === 0 && stats.industryBreakdown.length === 0) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">SG Jobs Cut by Month</h3>
          <MonthlyBarChart data={stats.monthlyBreakdown} metric="jobs" />
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Layoff Events by Month</h3>
          <MonthlyBarChart data={stats.monthlyBreakdown} metric="companies" />
        </div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Layoffs by Industry</h3>
        <IndustryPieChart data={stats.industryBreakdown} />
      </div>
    </div>
  );
}
