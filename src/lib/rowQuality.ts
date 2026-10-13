export interface RowQualityInput {
  status?: string | null;
  jobs_cut_sg?: number | null;
  jobs_cut_global?: number | null;
  pct_workforce?: number | null;
  source_link?: string | null;
}

function hasNonZero(value: number | null | undefined): boolean {
  return value != null && value !== 0;
}

export function rowQualityScore(row: RowQualityInput): number {
  let score = 0;
  if (row.status === 'confirmed') score += 3;
  if (hasNonZero(row.jobs_cut_sg ?? row.jobs_cut_global)) score += 2;
  if (hasNonZero(row.pct_workforce)) score += 1;
  if (row.source_link?.includes('web.archive.org')) score += 2;
  if (row.source_link && !row.source_link.includes('news.google.com')) score += 1;
  return score;
}
