import { GetStaticProps } from 'next';
import { readCsv } from '@/lib/csv';
import { computeStats } from '@/lib/stats';
import { LayoffEntry, AggregateStats } from '@/lib/types';
import Layout from '@/components/Layout';
import StatsBar from '@/components/StatsBar';
import FiltersBar from '@/components/FiltersBar';
import DataTable from '@/components/DataTable';
import ChartsSection from '@/components/ChartsSection';
import { useState } from 'react';

interface HomeProps {
  entries: LayoffEntry[];
  stats: AggregateStats;
}

export default function Home({ entries, stats }: HomeProps) {
  const [filtered, setFiltered] = useState<LayoffEntry[]>(entries);

  return (
    <Layout lastUpdated={stats.latestEntryDate}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Singapore Layoff Tracker</h1>
          <p className="mt-1 text-sm text-gray-500">
            Tracking layoff and retrenchment events at Singapore-based companies. Data sourced from public news reports.
          </p>
        </div>

        <div className="mb-8">
          <StatsBar stats={stats} />
        </div>

        {stats.monthlyBreakdown.length > 0 && (
          <div className="mb-8">
            <ChartsSection stats={stats} />
          </div>
        )}

        <div className="mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Entries</h2>
            <FiltersBar entries={entries} onFilterChange={setFiltered} />
          </div>
          <DataTable entries={filtered} />
        </div>
      </div>
    </Layout>
  );
}

export const getStaticProps: GetStaticProps<HomeProps> = async () => {
  const entries = readCsv('layoffs.csv').sort(
    (a, b) => b.date_announced.localeCompare(a.date_announced),
  );
  const stats = computeStats(entries);

  return {
    props: { entries, stats },
  };
};
