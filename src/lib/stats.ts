import { LayoffEntry, AggregateStats } from './types';

export function computeStats(entries: LayoffEntry[]): AggregateStats {
  const confirmed = entries.filter((e) => e.status === 'confirmed' || e.status === 'reference');
  const rumored = entries.filter((e) => e.status === 'rumored');

  const totalJobsCut = confirmed.reduce((sum, e) => sum + (e.jobs_cut ?? 0), 0);
  const companies = new Set(confirmed.map((e) => e.company.toLowerCase()));

  const sorted = [...confirmed].sort(
    (a, b) => new Date(b.date_announced).getTime() - new Date(a.date_announced).getTime()
  );
  const latestEntryDate = sorted[0]?.date_announced ?? '';

  const monthlyMap: Record<string, { jobs: number; count: number; rumoredCount: number }> = {};

  for (const entry of confirmed) {
    const d = new Date(entry.date_announced);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyMap[key]) monthlyMap[key] = { jobs: 0, count: 0, rumoredCount: 0 };
    monthlyMap[key].jobs += entry.jobs_cut ?? 0;
    monthlyMap[key].count += 1;
  }

  for (const entry of rumored) {
    const d = new Date(entry.date_announced);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyMap[key]) monthlyMap[key] = { jobs: 0, count: 0, rumoredCount: 0 };
    monthlyMap[key].rumoredCount += 1;
  }

  const monthlyBreakdown = Object.entries(monthlyMap)
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Industry breakdown
  const industryMap: Record<string, { jobs: number; count: number }> = {};
  for (const entry of confirmed) {
    const ind = entry.industry || 'Other';
    if (!industryMap[ind]) industryMap[ind] = { jobs: 0, count: 0 };
    industryMap[ind].jobs += entry.jobs_cut ?? 0;
    industryMap[ind].count += 1;
  }

  const industryBreakdown = Object.entries(industryMap)
    .map(([industry, data]) => ({ industry, ...data }))
    .sort((a, b) => b.jobs - a.jobs);

  return {
    totalJobsCut,
    totalCompanies: companies.size,
    totalConfirmed: confirmed.length,
    totalRumored: rumored.length,
    latestEntryDate,
    monthlyBreakdown,
    industryBreakdown,
  };
}
