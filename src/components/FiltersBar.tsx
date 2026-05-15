'use client';

import { LayoffEntry, INDUSTRIES } from '@/lib/types';

interface FiltersBarProps {
  entries: LayoffEntry[];
  onFilterChange: (filtered: LayoffEntry[]) => void;
}

export default function FiltersBar({ entries, onFilterChange }: FiltersBarProps) {
  function applyFilters(formData: FormData) {
    const search = (formData.get('search') as string).toLowerCase();
    const industry = formData.get('industry') as string;
    const status = formData.get('status') as string;
    const range = formData.get('range') as string;

    let filtered = [...entries];

    if (search) {
      filtered = filtered.filter(
        (e) =>
          e.company.toLowerCase().includes(search) ||
          e.industry.toLowerCase().includes(search) ||
          (e.notes && e.notes.toLowerCase().includes(search))
      );
    }

    if (industry && industry !== 'all') {
      filtered = filtered.filter((e) => e.industry === industry);
    }

    if (status && status !== 'all') {
      filtered = filtered.filter((e) => e.status === status);
    }

    if (range && range !== 'all') {
      const now = new Date();
      const months = parseInt(range);
      const cutoff = new Date(now.getFullYear(), now.getMonth() - months, 1);
      filtered = filtered.filter((e) => new Date(e.date_announced) >= cutoff);
    }

    onFilterChange(filtered);
  }

  return (
    <form
      className="flex flex-col sm:flex-row gap-3 flex-wrap"
      onChange={(e) => applyFilters(new FormData(e.currentTarget))}
    >
      <input
        name="search"
        type="text"
        placeholder="Search company, industry..."
        className="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
      />

      <select
        name="industry"
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
        name="status"
        className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
      >
        <option value="all">All Status</option>
        <option value="confirmed">Confirmed</option>
        <option value="rumored">Rumored</option>
      </select>

      <select
        name="range"
        defaultValue="all"
        className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
      >
        <option value="all">All Time</option>
        <option value="6">Past 6 Months</option>
        <option value="12">Past 12 Months</option>
        <option value="24">Past 2 Years</option>
      </select>
    </form>
  );
}
