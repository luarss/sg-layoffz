'use client';

import { ReactNode } from 'react';

export const ENTRIES_SECTION_ID = 'entries';

interface HeadlineProps {
  jobsCut: number;
  companies: number;
  undisclosedEvents: number;
  year: string;
  years: number[];
  onYearChange: (year: string) => void;
}

interface HeadlineItemProps {
  withSeparator?: boolean;
  children: ReactNode;
}

function HeadlineItem({ withSeparator = false, children }: HeadlineItemProps) {
  return (
    <li className="flex items-baseline">
      {withSeparator && (
        <span className="hidden sm:inline mr-3 text-gray-500" aria-hidden>
          ·
        </span>
      )}
      {children}
    </li>
  );
}

interface TotalLinkProps {
  value: number;
  label: string;
}

function TotalLink({ value, label }: TotalLinkProps) {
  return (
    <a href={`#${ENTRIES_SECTION_ID}`} className="group">
      <span className="text-3xl sm:text-4xl font-bold text-sky-700 tabular-nums underline decoration-sky-700/25 decoration-2 underline-offset-4 group-hover:decoration-sky-700">
        {value.toLocaleString()}
      </span>{' '}
      <span className="text-gray-600">{label}</span>
    </a>
  );
}

export default function Headline({
  jobsCut,
  companies,
  undisclosedEvents,
  year,
  years,
  onYearChange,
}: HeadlineProps) {
  return (
    <ul className="flex flex-col items-start gap-y-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3 text-base sm:text-lg text-gray-700">
      <HeadlineItem>
        <TotalLink value={jobsCut} label="confirmed Singapore jobs cut" />
      </HeadlineItem>
      <HeadlineItem withSeparator>
        <TotalLink value={companies} label="companies" />
      </HeadlineItem>
      {undisclosedEvents > 0 && (
        <HeadlineItem withSeparator>
          <a href={`#${ENTRIES_SECTION_ID}`} className="text-gray-600 text-sm sm:text-base hover:text-gray-900">
            <span className="font-semibold tabular-nums">
              {undisclosedEvents.toLocaleString()}
            </span>{' '}
            more events with undisclosed headcount
          </a>
        </HeadlineItem>
      )}
      <HeadlineItem withSeparator>
        <select
          value={year}
          onChange={(e) => onYearChange(e.target.value)}
          aria-label="Filter by year"
          className="px-2 py-1 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-sky-700 focus:border-transparent"
        >
          <option value="all">All time</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>
              In {y}
            </option>
          ))}
        </select>
      </HeadlineItem>
    </ul>
  );
}
