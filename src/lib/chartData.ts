const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const OUTLIER_RATIO = 3;

export function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split('-');
  return `${MONTH_NAMES[parseInt(monthNumber, 10) - 1]} ${year.slice(2)}`;
}

export function formatQuarterLabel(quarter: string): string {
  const [year, quarterName] = quarter.split('-');
  return `${quarterName} ${year}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export function niceCeiling(value: number): number {
  if (value <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(value)) / 2;
  return Math.ceil(value / step) * step;
}

export function findAxisCap(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => b - a);
  const [highest, secondHighest] = sorted;
  if (!secondHighest || secondHighest <= 0) return null;
  if (highest < secondHighest * OUTLIER_RATIO) return null;
  return niceCeiling(secondHighest * 1.25);
}

interface MonthlyRow {
  month: string;
  jobs: number;
  count: number;
  rumoredCount: number;
}

function monthRange(data: MonthlyRow[]): string {
  return `${formatMonthLabel(data[0].month)} to ${formatMonthLabel(data[data.length - 1].month)}`;
}

export function describeMonthlyJobs(data: MonthlyRow[]): string {
  if (data.length === 0) return 'No monthly data.';
  const peak = data.reduce((best, row) => (row.jobs > best.jobs ? row : best), data[0]);
  return (
    `Bar chart of disclosed Singapore jobs cut per month, ${monthRange(data)}. ` +
    `Highest month: ${formatMonthLabel(peak.month)} with ${pluralize(peak.jobs, 'job')}.`
  );
}

export function describeMonthlyEvents(data: MonthlyRow[]): string {
  if (data.length === 0) return 'No monthly data.';
  const confirmed = data.reduce((sum, row) => sum + row.count, 0);
  const rumored = data.reduce((sum, row) => sum + row.rumoredCount, 0);
  return (
    `Stacked bar chart of layoff events per month, ${monthRange(data)}, ` +
    `split into ${pluralize(confirmed, 'confirmed event')} and ${pluralize(rumored, 'rumored event')}.`
  );
}

interface IndustryRow {
  industry: string;
  jobs: number;
  count: number;
}

export function sortIndustriesByJobs(data: IndustryRow[]): IndustryRow[] {
  return [...data].sort((a, b) => b.jobs - a.jobs || b.count - a.count);
}

export function describeIndustries(data: IndustryRow[]): string {
  if (data.length === 0) return 'No industry data.';
  const ranked = sortIndustriesByJobs(data)
    .map((row) => `${row.industry} ${row.jobs.toLocaleString()}`)
    .join(', ');
  return `Horizontal bar chart of disclosed Singapore jobs cut by industry, largest first: ${ranked}.`;
}

interface BenchmarkRow {
  quarter: string;
  trackerJobs: number;
  momRetrenchments: number;
  coveragePct: number;
}

export function describeBenchmark(data: BenchmarkRow[]): string {
  if (data.length === 0) return 'No benchmark data.';
  const latest = data[data.length - 1];
  return (
    `Bar chart comparing MOM official retrenchments with jobs recorded by this tracker for ` +
    `${pluralize(data.length, 'quarter')}. Latest, ${formatQuarterLabel(latest.quarter)}: ` +
    `MOM ${latest.momRetrenchments.toLocaleString()}, tracker ${latest.trackerJobs.toLocaleString()} ` +
    `(${latest.coveragePct.toFixed(1)}%).`
  );
}
