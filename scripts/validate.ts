import { readCsv } from '../src/lib/csv';
import { LayoffEntry, INDUSTRIES } from '../src/lib/types';

interface ValidationError {
  row: number;
  field: string;
  message: string;
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

export function validateCsv(filename: string): { valid: boolean; errors: ValidationError[] } {
  const entries = readCsv(filename);
  const allErrors: ValidationError[] = [];

  for (let i = 0; i < entries.length; i++) {
    const errors = validateEntry(entries[i], i);
    allErrors.push(...errors);
  }

  if (allErrors.length === 0) {
    console.log(`✅ ${filename}: All ${entries.length} entries valid.`);
    return { valid: true, errors: [] };
  }

  console.error(`❌ ${filename}: ${allErrors.length} validation error(s):`);
  for (const err of allErrors) {
    console.error(`  Row ${err.row}, ${err.field}: ${err.message}`);
  }
  return { valid: false, errors: allErrors };
}

// CLI entry point
const file = process.argv[3] || 'layoffs.csv';
validateCsv(file);
