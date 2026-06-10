import { readCsv } from '../src/lib/csv';
import { LayoffEntry, INDUSTRIES } from '../src/lib/types';

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

interface IntegrityWarning {
  rows: number[];
  type: 'duplicate' | 'double-count' | 'superseded-rumor' | 'unarchived-confirmed';
  message: string;
}

// Known alternate names that map to the same company.
// Add new aliases here whenever the LLM uses an inconsistent name.
const COMPANY_ALIASES: Record<string, string> = {
  "yeo's": 'yeo hiap seng',
  'sea (shopee)': 'shopee',
  'citibank': 'citi',
  'citigroup': 'citi',
  'biontech singapore': 'biontech',
  'exxonmobil singapore': 'exxonmobil',
  'apbs (tiger beer)': 'heineken',
};

function normalizeCompany(name: string): string {
  const lower = name.toLowerCase().trim();
  return COMPANY_ALIASES[lower] ?? lower;
}

// Reputable direct domains that don't require Wayback archiving for confirmed status.
// news.google.com covers RSS-sourced entries that haven't been archived yet but
// link to legitimate outlets; resolve-gnews.ts handles those.
const REPUTABLE_DOMAINS = [
  'straitstimes.com',
  'channelnewsasia.com',
  'businesstimes.com.sg',
  'todayonline.com',
  'mothership.sg',
  'vulcanpost.com',
  'reuters.com',
  'bloomberg.com',
  'ft.com',
  'theonlinecitizen.com',
  'asiaone.com',
  'hrsea.economictimes.indiatimes.com',
  'fintechnews.sg',
  'stomp.sg',
  'ntuc.org.sg',
  'webintravel.com',
  'sg.finance.yahoo.com',
  '36kr.com',
  'news.google.com',
  'citywire.com',
  'law.asia',
];

function isReputableSource(url: string): boolean {
  if (!url) return false;
  if (url.includes('web.archive.org') || url.includes('archive.ph') || url.includes('archive.is')) return true;
  return REPUTABLE_DOMAINS.some((d) => url.includes(d));
}

export function validateEntry(entry: LayoffEntry, rowIndex: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const r = rowIndex + 1; // 1-based for user display

  if (!entry.company || String(entry.company).trim() === '') {
    errors.push({ row: r, field: 'company', message: 'Company name is required' });
  }

  if (!entry.date_announced || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date_announced))) {
    errors.push({ row: r, field: 'date_announced', message: 'Date must be YYYY-MM-DD' });
  }

  if (entry.jobs_cut !== null && entry.jobs_cut !== undefined) {
    if (typeof entry.jobs_cut !== 'number' || entry.jobs_cut < 0) {
      errors.push({ row: r, field: 'jobs_cut', message: 'Must be a positive number or empty' });
    }
  }

  if (entry.pct_workforce !== null && entry.pct_workforce !== undefined) {
    if (typeof entry.pct_workforce !== 'number' || entry.pct_workforce < 0 || entry.pct_workforce > 100) {
      errors.push({ row: r, field: 'pct_workforce', message: 'Must be 0-100 or empty' });
    }
  }

  if (entry.industry && !INDUSTRIES.includes(entry.industry as any)) {
    errors.push({ row: r, field: 'industry', message: `Must be one of: ${INDUSTRIES.join(', ')}` });
  }

  const validStatuses = ['rumored', 'confirmed', 'reference'];
  if (!validStatuses.includes(entry.status)) {
    errors.push({ row: r, field: 'status', message: `Must be one of: ${validStatuses.join(', ')}` });
  }

  if (!entry.source_link || String(entry.source_link).trim() === '') {
    errors.push({ row: r, field: 'source_link', message: 'Source link is required' });
  }

  return errors;
}

// Cross-entry integrity checks that catch duplicate events, superseded rumors,
// and confirmed entries sourced from unrecognized domains.
export function checkIntegrity(entries: LayoffEntry[]): IntegrityWarning[] {
  const warnings: IntegrityWarning[] = [];

  // Group by normalized company name
  const byCompany = new Map<string, { idx: number; entry: LayoffEntry }[]>();
  for (let i = 0; i < entries.length; i++) {
    const key = normalizeCompany(entries[i].company);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push({ idx: i, entry: entries[i] });
  }

  for (const group of byCompany.values()) {
    group.sort((a, b) => a.entry.date_announced.localeCompare(b.entry.date_announced));

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const msPerDay = 1000 * 60 * 60 * 24;
        const days = Math.round(
          (new Date(b.entry.date_announced).getTime() - new Date(a.entry.date_announced).getTime()) / msPerDay
        );

        if (days === 0) {
          warnings.push({
            rows: [a.idx + 1, b.idx + 1],
            type: 'duplicate',
            message: `Duplicate: "${a.entry.company}" and "${b.entry.company}" both on ${a.entry.date_announced}`,
          });
        } else if (days <= 7 && a.entry.status === 'confirmed' && b.entry.status === 'confirmed') {
          // Two confirmed entries for the same company within a fortnight often
          // reflect the same event covered in two articles (e.g. IBM Tampines).
          warnings.push({
            rows: [a.idx + 1, b.idx + 1],
            type: 'double-count',
            message: `Possible double-count: "${a.entry.company}" confirmed on ${a.entry.date_announced} and again on ${b.entry.date_announced} (${days}d apart)`,
          });
        }

        // A rumored entry within 30 days before a confirmed one is likely noise.
        if (a.entry.status === 'rumored' && b.entry.status === 'confirmed' && days >= 0 && days <= 30) {
          warnings.push({
            rows: [a.idx + 1, b.idx + 1],
            type: 'superseded-rumor',
            message: `Superseded rumor: "${a.entry.company}" row ${a.idx + 1} (${a.entry.date_announced}, rumored) appears to precede confirmed entry on ${b.entry.date_announced}`,
          });
        }
      }
    }
  }

  // Confirmed entries must use a Wayback-archived or recognised direct source.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.status === 'confirmed' && !isReputableSource(String(e.source_link ?? ''))) {
      warnings.push({
        rows: [i + 1],
        type: 'unarchived-confirmed',
        message: `Unrecognised source for confirmed entry: "${e.company}" (${e.date_announced}) — ${e.source_link}`,
      });
    }
  }

  return warnings;
}

export function validateCsv(filename: string): { valid: boolean; errors: ValidationError[]; warnings: IntegrityWarning[] } {
  const entries = readCsv(filename);
  const allErrors: ValidationError[] = [];

  for (let i = 0; i < entries.length; i++) {
    const errors = validateEntry(entries[i], i);
    allErrors.push(...errors);
  }

  const warnings = checkIntegrity(entries);

  if (allErrors.length === 0 && warnings.length === 0) {
    console.log(`✅ ${filename}: All ${entries.length} entries valid.`);
    return { valid: true, errors: [], warnings: [] };
  }

  if (allErrors.length > 0) {
    console.error(`❌ ${filename}: ${allErrors.length} validation error(s):`);
    for (const err of allErrors) {
      console.error(`  Row ${err.row}, ${err.field}: ${err.message}`);
    }
  }

  if (warnings.length > 0) {
    console.warn(`\n⚠️  ${filename}: ${warnings.length} integrity warning(s):`);
    for (const w of warnings) {
      const rowLabel = w.rows.length === 1 ? `Row ${w.rows[0]}` : `Rows ${w.rows.join(' & ')}`;
      console.warn(`  [${w.type}] ${rowLabel}: ${w.message}`);
    }
  }

  return { valid: allErrors.length === 0, errors: allErrors, warnings };
}

// CLI entry point
const file = process.argv[3] || 'layoffs.csv';
validateCsv(file);
