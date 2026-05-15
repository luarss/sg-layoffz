import { AggregateStats } from '@/lib/types';

interface StatsBarProps {
  stats: AggregateStats;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 sm:p-6">
      <dt className="text-sm font-medium text-gray-500 truncate">{label}</dt>
      <dd className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900">{value}</dd>
    </div>
  );
}

export default function StatsBar({ stats }: StatsBarProps) {
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        label="Total Jobs Cut"
        value={stats.totalJobsCut.toLocaleString()}
      />
      <StatCard
        label="Companies Tracked"
        value={stats.totalCompanies.toLocaleString()}
      />
      <StatCard
        label="Confirmed Entries"
        value={stats.totalConfirmed.toLocaleString()}
      />
      <StatCard
        label="Latest Entry"
        value={stats.latestEntryDate || '—'}
      />
    </dl>
  );
}
