export interface LayoffEntry {
  company: string;
  date_announced: string; // YYYY-MM-DD — when the layoff event happened / was announced by the company
  date_reported: string; // YYYY-MM-DD — article / publication date of this row's source
  jobs_cut_sg: number | null; // Singapore headcount only
  jobs_cut_global: number | null; // global/worldwide figure when the source gave one
  pct_workforce: number | null;
  industry: string;
  source_link: string;
  notes: string;
  status: 'rumored' | 'confirmed' | 'reference' | 'denied' | 'expired';
  event_id: string; // kebab-case slug identifying the underlying event; follow-up rows share one id
}

export interface ReviewEntry extends LayoffEntry {
  review_id: string;
  candidate_urls: string;
  snippet: string;
}

export interface AggregateStats {
  // Sum over confirmed EVENTS of the event's SG headcount (max jobs_cut_sg across the
  // event's rows, so follow-up coverage of one event is never double-counted).
  totalJobsCut: number;
  totalCompanies: number; // distinct companies with at least one confirmed event
  totalConfirmed: number; // distinct confirmed EVENTS (event_id with ≥1 confirmed row)
  totalRumored: number; // distinct rumored EVENTS (event_id with only rumored rows)
  undisclosedEvents: number; // confirmed events with no SG headcount disclosed
  latestEntryDate: string;
  monthlyBreakdown: { month: string; jobs: number; count: number; rumoredCount: number }[];
  industryBreakdown: { industry: string; jobs: number; count: number }[];
}

export const INDUSTRIES = [
  'Tech',
  'Finance',
  'Manufacturing',
  'Retail',
  'F&B',
  'Real Estate',
  'Healthcare',
  'Education',
  'Other',
] as const;

export const CSV_HEADERS: (keyof LayoffEntry)[] = [
  'company',
  'date_announced',
  'date_reported',
  'jobs_cut_sg',
  'jobs_cut_global',
  'pct_workforce',
  'industry',
  'source_link',
  'notes',
  'status',
  'event_id',
];
