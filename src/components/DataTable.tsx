'use client';

import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  ColumnDef,
  SortingState,
  flexRender,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { LayoffEntry } from '@/lib/types';

interface DataTableProps {
  entries: LayoffEntry[];
}

// Rows sharing an event_id are follow-up coverage of one event. Given the visible
// rows, return the set of row identities that are NOT the primary (earliest by
// date_announced) row of their event, so the table can badge them as follow-ups.
function computeFollowUps(entries: LayoffEntry[]): Set<LayoffEntry> {
  const byEvent = new Map<string, LayoffEntry[]>();
  for (const e of entries) {
    if (!e.event_id) continue;
    if (!byEvent.has(e.event_id)) byEvent.set(e.event_id, []);
    byEvent.get(e.event_id)!.push(e);
  }
  const followUps = new Set<LayoffEntry>();
  for (const rows of byEvent.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) =>
      String(a.date_announced).localeCompare(String(b.date_announced))
    );
    for (const r of sorted.slice(1)) followUps.add(r);
  }
  return followUps;
}

function buildColumns(followUps: Set<LayoffEntry>): ColumnDef<LayoffEntry>[] {
  return [
  {
    accessorKey: 'company',
    header: 'Company',
    cell: (info) => (
      <span className="inline-flex items-center gap-2">
        <span className="font-semibold text-gray-900">{info.getValue<string>()}</span>
        {followUps.has(info.row.original) && (
          <span
            className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500"
            title={`Follow-up coverage of event "${info.row.original.event_id}"`}
          >
            follow-up
          </span>
        )}
      </span>
    ),
  },
  {
    accessorKey: 'date_announced',
    header: 'Date',
    cell: (info) => info.getValue<string>(),
  },
  {
    accessorKey: 'jobs_cut_sg',
    header: 'Jobs Cut (SG)',
    cell: (info) => {
      const sg = info.getValue<number | null>();
      const global = info.row.original.jobs_cut_global;
      return (
        <span>
          {sg != null ? (
            <span className="tabular-nums">{sg.toLocaleString()}</span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
          {global != null && (
            <span className="ml-1 text-xs text-gray-400">
              ({global.toLocaleString()} global)
            </span>
          )}
        </span>
      );
    },
  },
  {
    accessorKey: 'pct_workforce',
    header: '% Workforce',
    cell: (info) => {
      const v = info.getValue<number | null>();
      return v ? `${v}%` : <span className="text-gray-400">—</span>;
    },
  },
  {
    accessorKey: 'industry',
    header: 'Industry',
    cell: (info) => (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
        {info.getValue<string>()}
      </span>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (info) => {
      const s = info.getValue<string>();
      const cls =
        s === 'confirmed'
          ? 'status-badge status-confirmed'
          : s === 'reference'
          ? 'status-badge status-reference'
          : 'status-badge status-rumored';
      return <span className={cls}>{s}</span>;
    },
  },
  {
    accessorKey: 'source_link',
    header: 'Source',
    cell: (info) => (
      <a
        href={info.getValue<string>()}
        target="_blank"
        rel="noopener noreferrer"
        className="text-gray-400 hover:text-gray-600 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
          <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
        </svg>
      </a>
    ),
  },
  {
    accessorKey: 'notes',
    header: 'Notes',
    cell: (info) => {
      const v = info.getValue<string>();
      return v ? (
        <span className="text-sm text-gray-500 truncate max-w-[200px] block" title={v}>
          {v}
        </span>
      ) : (
        <span className="text-gray-400">—</span>
      );
    },
  },
  ];
}

export default function DataTable({ entries }: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const followUps = useMemo(() => computeFollowUps(entries), [entries]);
  const columns = useMemo(() => buildColumns(followUps), [followUps]);

  const table = useReactTable({
    data: entries,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (entries.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        No entries match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:bg-gray-100 transition-colors"
                >
                  <div className="flex items-center gap-1">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{
                      asc: <span className="text-gray-400">▲</span>,
                      desc: <span className="text-gray-400">▼</span>,
                    }[header.column.getIsSorted() as string] ?? null}
                  </div>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="hover:bg-gray-50 transition-colors">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3 text-sm whitespace-nowrap">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-500">
        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
      </div>
    </div>
  );
}
