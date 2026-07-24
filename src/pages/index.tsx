import { GetStaticProps } from 'next';
import { readCsv } from '@/lib/csv';
import { computeStats } from '@/lib/stats';
import { loadMomBenchmark, buildBenchmarkComparison, BenchmarkComparisonRow } from '@/lib/momBenchmark';
import { LayoffEntry } from '@/lib/types';
import Layout from '@/components/Layout';
import Headline from '@/components/Headline';
import FiltersBar, { Filters, EMPTY_FILTERS, applyFilters } from '@/components/FiltersBar';
import DataTable from '@/components/DataTable';
import ChartsSection from '@/components/ChartsSection';
import MomBenchmark from '@/components/MomBenchmark';
import { useMemo, useState } from 'react';

interface HomeProps {
  entries: LayoffEntry[];
  years: number[];
  latestYear: number | null;
  globalLatestDate: string;
  momComparison: BenchmarkComparisonRow[];
}

export default function Home({ entries, years, latestYear, globalLatestDate, momComparison }: HomeProps) {
  const [filters, setFilters] = useState<Filters>({
    ...EMPTY_FILTERS,
    year: latestYear !== null ? String(latestYear) : 'all',
  });

  const filtered = useMemo(() => applyFilters(entries, filters), [entries, filters]);
  const stats = useMemo(() => computeStats(filtered), [filtered]);

  return (
    <Layout lastUpdated={globalLatestDate}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Singapore Layoff Tracker</h1>
          <p className="mt-1 text-sm text-gray-500">
            Tracking layoff and retrenchment events at Singapore-based companies. Data sourced from public news reports.
          </p>
        </div>

        <div className="mb-10">
          <Headline
            jobsCut={stats.totalJobsCut}
            companies={stats.totalCompanies}
            undisclosedEvents={stats.undisclosedEvents}
            year={filters.year}
            years={years}
            onYearChange={(year) => setFilters({ ...filters, year })}
          />
        </div>

        {stats.monthlyBreakdown.length > 0 && (
          <div className="mb-8">
            <ChartsSection stats={stats} />
          </div>
        )}

        {momComparison.length > 0 && (
          <div className="mb-8">
            <MomBenchmark comparison={momComparison} />
          </div>
        )}

        <div className="mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Entries</h2>
            <FiltersBar filters={filters} onChange={setFilters} />
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

  const yearSet = new Set<number>();
  for (const e of entries) {
    const y = parseInt(e.date_announced.slice(0, 4), 10);
    if (!Number.isNaN(y)) yearSet.add(y);
  }
  const years = [...yearSet].sort((a, b) => b - a);
  const latestYear = years[0] ?? null;
  const globalLatestDate = entries[0]?.date_announced ?? '';

  // The MOM benchmark spans multiple years, so compare it against all-time tracker
  // stats rather than a year-filtered view. Computed here (server-side) so the
  // fs-based CSV loader never enters the client bundle.
  const allTimeStats = computeStats(entries);
  const momComparison = buildBenchmarkComparison(
    allTimeStats.monthlyBreakdown,
    loadMomBenchmark(),
  );

  return {
    props: { entries, years, latestYear, globalLatestDate, momComparison },
  };
};
