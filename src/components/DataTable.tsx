'use client';

import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  ColumnDef,
  SortingState,
  flexRender,
} from '@tanstack/react-table';
import { Fragment, useMemo, useState } from 'react';
import { LayoffEntry } from '@/lib/types';

import {
  GroupedEventEntry,
  groupEntriesByEvent,
  getEventKey,
} from '@/lib/groupEvents';

export type { GroupedEventEntry };
export { groupEntriesByEvent, getEventKey };

interface DataTableProps {
  entries: LayoffEntry[];
}


function buildColumns(
  expandedIds: Set<string>,
  toggleExpand: (eventId: string) => void
): ColumnDef<GroupedEventEntry>[] {
  return [
    {
      accessorKey: 'company',
      header: 'Company',
      cell: (info) => {
        const item = info.row.original;
        const hasFollowUps = item.followUps.length > 0;
        const isExpanded = expandedIds.has(item.eventId);
        return (
          <span className="inline-flex items-center gap-2">
            <span className="font-semibold text-gray-900">{info.getValue<string>()}</span>
            {hasFollowUps && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(item.eventId);
                }}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-colors border select-none ${
                  isExpanded
                    ? 'bg-blue-100 text-blue-800 border-blue-300'
                    : 'bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200'
                }`}
                title={
                  isExpanded
                    ? 'Click to collapse follow-up coverage'
                    : `Click to expand ${item.followUps.length} follow-up coverage update${item.followUps.length > 1 ? 's' : ''}`
                }
                aria-expanded={isExpanded}
              >
                <svg
                  className={`w-3 h-3 text-blue-600 transform transition-transform duration-150 ${
                    isExpanded ? 'rotate-90' : ''
                  }`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>
                  {item.followUps.length} {item.followUps.length === 1 ? 'follow-up' : 'follow-ups'}
                </span>
              </button>
            )}
          </span>
        );
      },
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
          title={info.getValue<string>()}
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const groupedEvents = useMemo(() => groupEntriesByEvent(entries), [entries]);

  const toggleExpand = (eventId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  const eventsWithFollowUps = useMemo(
    () => groupedEvents.filter((e) => e.followUps.length > 0),
    [groupedEvents]
  );

  const totalFollowUps = useMemo(
    () => groupedEvents.reduce((acc, e) => acc + e.followUps.length, 0),
    [groupedEvents]
  );

  const allExpanded =
    eventsWithFollowUps.length > 0 &&
    eventsWithFollowUps.every((e) => expandedIds.has(e.eventId));

  const toggleAllExpanded = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(eventsWithFollowUps.map((e) => e.eventId)));
    }
  };

  const columns = useMemo(
    () => buildColumns(expandedIds, toggleExpand),
    [expandedIds]
  );

  const table = useReactTable({
    data: groupedEvents,
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
          {table.getRowModel().rows.map((row) => {
            const item = row.original;
            const hasFollowUps = item.followUps.length > 0;
            const isExpanded = expandedIds.has(item.eventId);

            return (
              <Fragment key={row.id}>
                <tr
                  className={`transition-colors ${
                    isExpanded ? 'bg-blue-50/20' : 'hover:bg-gray-50'
                  }`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 text-sm whitespace-nowrap">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>

                {hasFollowUps && isExpanded && (
                  <tr className="bg-slate-50/70 border-y border-slate-200">
                    <td colSpan={columns.length} className="px-4 py-3 sm:px-6">
                      <div className="rounded-lg border border-slate-200 bg-white shadow-xs overflow-hidden">
                        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-800 uppercase tracking-wider text-[11px]">
                              Follow-up Coverage
                            </span>
                            <span className="rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                              {item.followUps.length} update{item.followUps.length > 1 ? 's' : ''}
                            </span>
                          </div>
                          {item.event_id && (
                            <span className="text-slate-400 font-mono text-[11px]">
                              event: {item.event_id}
                            </span>
                          )}
                        </div>
                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-slate-100 text-xs">
                            <thead className="bg-slate-50/60 text-slate-500">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium">Date</th>
                                <th className="px-3 py-2 text-left font-medium">Company / Source Name</th>
                                <th className="px-3 py-2 text-left font-medium">Jobs Cut (SG)</th>
                                <th className="px-3 py-2 text-left font-medium">% Workforce</th>
                                <th className="px-3 py-2 text-left font-medium">Status</th>
                                <th className="px-3 py-2 text-left font-medium">Source</th>
                                <th className="px-3 py-2 text-left font-medium">Notes</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 bg-white">
                              {item.followUps.map((fu, idx) => (
                                <tr key={idx} className="hover:bg-slate-50/60 transition-colors">
                                  <td className="px-3 py-2 text-slate-700 font-medium whitespace-nowrap">
                                    {fu.date_announced}
                                  </td>
                                  <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                                    <span className="font-medium">{fu.company}</span>
                                    {fu.company !== item.company && (
                                      <span className="ml-1.5 text-[10px] text-gray-400 font-normal">
                                        (alias of {item.company})
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                                    {fu.jobs_cut_sg != null ? (
                                      <span className="tabular-nums font-medium">
                                        {fu.jobs_cut_sg.toLocaleString()}
                                      </span>
                                    ) : (
                                      <span className="text-slate-400">—</span>
                                    )}
                                    {fu.jobs_cut_global != null && (
                                      <span className="ml-1 text-[11px] text-slate-400">
                                        ({fu.jobs_cut_global.toLocaleString()} global)
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                                    {fu.pct_workforce != null ? (
                                      `${fu.pct_workforce}%`
                                    ) : (
                                      <span className="text-slate-400">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    <span
                                      className={`status-badge text-[10px] ${
                                        fu.status === 'confirmed'
                                          ? 'status-confirmed'
                                          : fu.status === 'reference'
                                          ? 'status-reference'
                                          : 'status-rumored'
                                      }`}
                                    >
                                      {fu.status}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    <a
                                      href={fu.source_link}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-slate-400 hover:text-slate-600 transition-colors inline-flex items-center"
                                      title={fu.source_link}
                                    >
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        className="h-3.5 w-3.5"
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                      >
                                        <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                                        <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                                      </svg>
                                    </a>
                                  </td>
                                  <td className="px-3 py-2 text-slate-500 max-w-md truncate" title={fu.notes}>
                                    {fu.notes || <span className="text-slate-400">—</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-200 text-xs text-gray-500 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium text-gray-700">
            {groupedEvents.length} {groupedEvents.length === 1 ? 'event' : 'events'}
          </span>
          {totalFollowUps > 0 && (
            <span className="text-gray-400 ml-1.5">
              ({entries.length} total entries, including {totalFollowUps} follow-up{totalFollowUps > 1 ? 's' : ''})
            </span>
          )}
        </div>
        {totalFollowUps > 0 && (
          <button
            type="button"
            onClick={toggleAllExpanded}
            className="text-blue-600 hover:text-blue-800 font-medium transition-colors cursor-pointer select-none"
          >
            {allExpanded ? 'Collapse all follow-ups' : 'Expand all follow-ups'}
          </button>
        )}
      </div>
    </div>
  );
}

