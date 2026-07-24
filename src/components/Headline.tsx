'use client';

interface HeadlineProps {
  jobsCut: number;
  companies: number;
  undisclosedEvents: number;
  year: string;
  years: number[];
  onYearChange: (year: string) => void;
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
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 text-base sm:text-lg text-gray-700">
      <span>
        <span className="text-3xl sm:text-4xl font-bold text-sky-500 tabular-nums">
          {jobsCut.toLocaleString()}
        </span>{' '}
        <span className="text-gray-600">confirmed Singapore jobs cut</span>
      </span>
      <span className="text-gray-400" aria-hidden>
        ·
      </span>
      <span>
        <span className="text-3xl sm:text-4xl font-bold text-sky-500 tabular-nums">
          {companies.toLocaleString()}
        </span>{' '}
        <span className="text-gray-600">companies</span>
      </span>
      {undisclosedEvents > 0 && (
        <>
          <span className="text-gray-400" aria-hidden>
            ·
          </span>
          <span className="text-gray-500 text-sm sm:text-base">
            <span className="font-semibold text-gray-600 tabular-nums">
              {undisclosedEvents.toLocaleString()}
            </span>{' '}
            more events with undisclosed headcount
          </span>
        </>
      )}
      <span className="text-gray-400" aria-hidden>
        ·
      </span>
      <select
        value={year}
        onChange={(e) => onYearChange(e.target.value)}
        aria-label="Filter by year"
        className="px-2 py-1 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
      >
        <option value="all">All time</option>
        {years.map((y) => (
          <option key={y} value={String(y)}>
            In {y}
          </option>
        ))}
      </select>
    </div>
  );
}
