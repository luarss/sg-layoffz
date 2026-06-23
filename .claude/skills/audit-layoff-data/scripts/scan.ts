// Data-integrity scan for the sg-layoffz datasets.
//
// Catches the two failure modes that have actually slipped past CI:
//   1. Row gluing — a row whose field count != 8, caused by appending to a file whose
//      last row lacked a trailing newline (e.g. status "rumored" fused with the next
//      company "Kee Wah Bakery" → "rumoredKee Wah Bakery"). The status enum check in
//      validate.ts only flags the symptom; this pinpoints the merged row directly.
//   2. Duplicates / double-counts — exact company+date repeats, plus same-company
//      clusters worth a human double-count review (validate.ts already warns on
//      near-date confirmed pairs; this gives the broader picture).
//
// Run from the repo root:  npx tsx .claude/skills/audit-layoff-data/scripts/scan.ts
// Exit code is non-zero if any malformed (glued) row is found, so it can gate CI.

import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';

const EXPECTED_FIELDS = 8;
const FILES = ['layoffs.csv', 'rejected.csv'];

function normCompany(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\b(pte|ltd|inc|llc|singapore|sg|limited|corp|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

let hadError = false;

for (const file of FILES) {
  const full = path.join(process.cwd(), 'data', file);
  if (!fs.existsSync(full)) continue;
  const raw = fs.readFileSync(full, 'utf-8').replace(/\r\n?/g, '\n');

  // --- 1. Malformed rows (field-count mismatch = likely row gluing) ---
  const rows = Papa.parse<string[]>(raw, { skipEmptyLines: true }).data;
  const malformed = rows
    .map((r, i) => ({ line: i + 1, n: r.length, first: String(r[0]).slice(0, 50) }))
    .filter((r) => r.n !== EXPECTED_FIELDS);
  if (malformed.length) {
    hadError = true;
    console.error(`\n❌ ${file}: ${malformed.length} malformed row(s) (expected ${EXPECTED_FIELDS} fields):`);
    for (const m of malformed) console.error(`   line ${m.line}: ${m.n} fields | ${m.first}`);
  } else {
    console.log(`\n✓ ${file}: all rows have ${EXPECTED_FIELDS} fields`);
  }
}

// --- 2. Duplicate / double-count review (layoffs.csv only) ---
const layoffsRaw = fs
  .readFileSync(path.join(process.cwd(), 'data', 'layoffs.csv'), 'utf-8')
  .replace(/\r\n?/g, '\n');
const parsed = Papa.parse<Record<string, string>>(layoffsRaw, { header: true, skipEmptyLines: true }).data;

const byKey = new Map<string, number[]>();
const byCompany = new Map<string, { date: string; status: string }[]>();
parsed.forEach((r, i) => {
  const key = `${normCompany(r.company)}|${r.date_announced ?? ''}`;
  (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(i + 2);
  const c = normCompany(r.company);
  (byCompany.get(c) ?? byCompany.set(c, []).get(c)!).push({
    date: r.date_announced ?? '',
    status: r.status ?? '',
  });
});

const exactDupes = [...byKey].filter(([, idx]) => idx.length > 1);
console.log('\n=== Exact company+date duplicates ===');
if (!exactDupes.length) console.log('  none');
for (const [k, idx] of exactDupes) console.log(`  rows ${idx.join(', ')} -> ${k}`);

console.log('\n=== Companies appearing 3+ times (manual double-count review) ===');
const clusters = [...byCompany].filter(([, arr]) => arr.length >= 3);
if (!clusters.length) console.log('  none');
for (const [c, arr] of clusters) {
  console.log(`  ${c} (${arr.length}): ${arr.map((a) => `${a.date}/${a.status}`).join(', ')}`);
}

if (hadError) process.exit(1);
