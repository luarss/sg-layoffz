export interface LayoffEntry {
  company: string;
  date_announced: string; // YYYY-MM-DD
  jobs_cut: number | null;
  pct_workforce: number | null;
  industry: string;
  source_link: string;
  notes: string;
  status: 'rumored' | 'confirmed' | 'reference';
}

export interface ReviewEntry extends LayoffEntry {
  review_id: string;
  candidate_urls: string;
  snippet: string;
}

export interface AggregateStats {
  totalJobsCut: number;
  totalCompanies: number;
  totalConfirmed: number;
  totalRumored: number;
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
  'jobs_cut',
  'pct_workforce',
  'industry',
  'source_link',
  'notes',
  'status',
];
