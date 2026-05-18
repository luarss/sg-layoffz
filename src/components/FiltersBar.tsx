'use client';

import { LayoffEntry, INDUSTRIES } from '@/lib/types';

export interface Filters {
  search: string;
  industry: string;
  status: string;
  year: string;
  range: string;
}

export const EMPTY_FILTERS: Filters = {
  search: '',
  industry: 'all',
  status: 'all',
  year: 'all',
  range: 'all',
};

interface FiltersBarProps {
  filters: Filters;
  onChange: (next: Filters) => void;
}

export function applyFilters(entries: LayoffEntry[], filters: Filters): LayoffEntry[] {
  const search = filters.search.trim().toLowerCase();
  const months = filters.range !== 'all' ? parseInt(filters.range, 10) : null;
  const now = new Date();
  const rangeCutoff =
    months !== null ? new Date(now.getFullYear(), now.getMonth() - months, 1) : null;

  return entries.filter((e) => {
    if (search) {
      const hit =
        e.company.toLowerCase().includes(search) ||
        e.industry.toLowerCase().includes(search) ||
        (e.notes && e.notes.toLowerCase().includes(search));
      if (!hit) return false;
    }
    if (filters.industry !== 'all' && e.industry !== filters.industry) return false;
    if (filters.status !== 'all' && e.status !== filters.status) return false;
    if (filters.year !== 'all' && !e.date_announced.startsWith(`${filters.year}-`)) return false;
    if (rangeCutoff && new Date(e.date_announced) < rangeCutoff) return false;
    return true;
  });
}

export default function FiltersBar({ filters, onChange }: FiltersBarProps) {
  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
      <input
        type="text"
        placeholder="Search company, industry..."
        value={filters.search}
        onChange={(e) => update('search', e.target.value)}
        className="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
      />

      <select
        value={filters.industry}
        onChange={(e) => update('industry', e.target.value)}
        className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
      >
        <option value="all">All Industries</option>
        {INDUSTRIES.map((ind) => (
          <option key={ind} value={ind}>
            {ind}
          </option>
        ))}
      </select>

      <select
        value={filters.status}
        onChange={(e) => update('status', e.target.value)}
        className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
      >
        <option value="all">All Status</option>
        <option value="confirmed">Confirmed</option>
        <option value="rumored">Rumored</option>
      </select>

      <select
        value={filters.range}
        onChange={(e) => update('range', e.target.value)}
        className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
      >
        <option value="all">All Time</option>
        <option value="6">Past 6 Months</option>
        <option value="12">Past 12 Months</option>
        <option value="24">Past 2 Years</option>
      </select>
    </div>
  );
}
