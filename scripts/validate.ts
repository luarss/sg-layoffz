import { readCsv } from '../src/lib/csv';
import { LayoffEntry, INDUSTRIES } from '../src/lib/types';
import { normalizeCompany } from './normalize';
import { extractGnFingerprint } from './deduplicate';

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

interface IntegrityWarning {
  rows: number[];
  type:
    | 'duplicate'
    | 'double-count'
    | 'superseded-rumor'
    | 'unarchived-confirmed'
    | 'future-date'
    | 'vague-company'
    | 'duplicate-source'
    | 'global-figure'
    | 'contradictory-verdict'
    | 'cross-file-contradiction'
    | 'possible-same-event';
  message: string;
}

// Today in YYYY-MM-DD. Overridable via VALIDATE_TODAY so tests are deterministic.
function today(): string {
  return process.env.VALIDATE_TODAY || new Date().toISOString().slice(0, 10);
}

// Company strings that don't name a specific, identifiable company. A confirmed
// entry must point to a real named company (the LLM's company_identifiable rule),
// so these are surfaced for manual naming or rejection. The trailing alternative
// catches generic descriptive placeholders ("Another Legacy Bank", "A major bank",
// "A leading retailer") that name a category instead of a company.
export const VAGUE_COMPANY =
  /not specified|not named|unnamed|undisclosed|\bname not\b|\(name|firm\)|manager\)?$|company\)$|^(?:a|an|another)\s+(?:\w+\s+)*(?:bank|firm|company|startup|business|retailer|mnc|multinational|tech\s+firm|lender|insurer)$/i;

// Notes language that signals a future plan, an unconfirmed report, or a noticed
// duplicate — i.e. the entry should be `rumored` (or rejected), not `confirmed`.
export const HEDGE_NOTES = /\bplans? to\b|\bexpected to\b|\bmay (?:lay|cut)\b|not confirmed|unconfirmed|appears future|date appears future|potential duplicate|likely the article|future plan|ambiguity|not clear(?:ly)?/i;

// Notes that state the headcount is a global/worldwide figure. When such an entry
// is `confirmed`, its jobs_cut is summed into the site's headline totalJobsCut even
// though most of those roles are not in Singapore. The "sites in … and …" and
// multi-country alternatives catch figures spanning more than just Singapore even
// when the words "global"/"worldwide" are absent (e.g. "sites in Germany and
// Singapore, affecting 1,860 staff").
const GLOBAL_FIGURE =
  /\bglobal(?:ly)?\b|worldwide|across (?:divisions|the group)|sg office potentially|sites?\s+in\s+.+\s+and\s+|multiple (?:countries|markets|regions|sites)/i;

// Cross-name same-event detection (see checkIntegrity). Two articles about ONE
// event often arrive under different surface company names — "Eunos Canteen",
// "Unnamed Eunos Coffee Shop", "友诺士咖啡店业者" — so the company-keyed grouping
// never collates them. We instead look for a shared *rare* content token (e.g. a
// location or brand) between near-date entries. These stopwords are the generic
// layoff/closure vocabulary that co-occurs across unrelated events and must never
// be treated as a shared-event signal.
const SAME_EVENT_STOPWORDS = new Set([
  'singapore', 'singaporean', 'singaporeans', 'company', 'companies', 'staff',
  'employee', 'employees', 'worker', 'workers', 'jobs', 'role', 'roles',
  'layoff', 'layoffs', 'retrench', 'retrenched', 'retrenchment', 'cuts', 'cut',
  'cutting', 'closure', 'close', 'closing', 'closed', 'shut', 'shuts', 'cease',
  'ceased', 'ceases', 'business', 'businesses', 'report', 'reported', 'reports',
  'article', 'confirmed', 'rumored', 'event', 'events', 'loss', 'losses', 'losing',
  'affected', 'affecting', 'operations', 'office', 'offices', 'store', 'stores',
  'outlet', 'outlets', 'workforce', 'headcount', 'restructuring', 'reorganising',
  'announced', 'announces', 'announce', 'plans', 'planned', 'future', 'implying',
  'implies', 'imply', 'result', 'resulting', 'results', 'source', 'credible',
  'news', 'coffee', 'shop', 'shops', 'stall', 'stalls', 'vendor', 'vendors',
  'canteen', 'restaurant', 'eatery', 'hawker', 'lease', 'operator', 'operators',
  'vacate', 'renew', 'renewal', 'month', 'months', 'located', 'nexus', 'classified',
  'rules', 'given', 'their', 'that', 'this', 'with', 'from', 'have', 'been', 'will',
  'more', 'than', 'over', 'also', 'into', 'part', 'amid', 'about', 'were', 'told',
  'move', 'moving', 'forced', 'making', 'company', 'per', 'not', 'and', 'the',
  'unnamed', 'undisclosed', 'specified', 'provided', 'identifiable', 'snippet',
  // Generic corporate/industry words that recur across unrelated company names.
  'bank', 'banks', 'group', 'holding', 'holdings', 'global', 'international',
  'platforms', 'technologies', 'technology', 'services', 'solutions', 'capital',
  'ventures', 'labs', 'studios', 'digital', 'mobile', 'house', 'centre', 'center',
  'asia', 'pacific', 'financial', 'systems', 'media', 'partners', 'industries',
]);

// A significant token appearing in at most this many entries is treated as
// distinctive enough (a location, brand, or unusual word) that two near-date
// entries sharing it likely describe the same event.
const SAME_EVENT_RARE_DF_MAX = 5;
const SAME_EVENT_WINDOW_DAYS = 21;

// Extract distinctive lowercase word tokens (≥4 letters, minus stopwords) from an
// entry's company name — the one surface where a shared token is a genuine brand or
// location signal ("jetstar", "oatly", "eunos"). The source URL (news-site section
// slugs, Google-News base64) and the LLM `notes` prose are deliberately excluded:
// both are full of incidental mid-frequency words that produce false matches.
function significantTokens(entry: LayoffEntry): Set<string> {
  const text = String(entry.company ?? '').toLowerCase();
  const out = new Set<string>();
  for (const tok of text.split(/[^a-z]+/)) {
    if (tok.length >= 4 && !SAME_EVENT_STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

// Normalise a source URL for duplicate detection: drop the Wayback prefix, tracking
// query strings, and trailing slashes so the same underlying article matches.
function normalizeUrl(url: string): string {
  if (!url) return '';
  let u = url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+\//, '');
  u = u.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return u.toLowerCase();
}

// Company aliasing is shared with the scrape/dedup pipeline — see the single
// COMPANY_ALIASES source of truth in scripts/normalize.ts. Integrity grouping
// lowercases the normalized key so case differences never split a company.

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
    const key = normalizeCompany(entries[i].company).toLowerCase();
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
        } else if (days <= 31 && a.entry.status === 'confirmed' && b.entry.status === 'confirmed') {
          // Two confirmed entries for the same company within a month often reflect the
          // same event covered in two articles dated days/weeks apart (e.g. BioNTech's SG
          // plant closure carried 2026-04-06, 2026-05-05). This is a review warning, not a
          // hard failure — genuinely separate rounds a few weeks apart are flagged for a
          // human to confirm rather than auto-merged (dedup-layoffs.ts keeps its tighter
          // 7-day auto-delete window to avoid collapsing real distinct rounds).
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

  // Cross-name same-event double-count: the company-keyed loop above only catches
  // repeats under the *same* normalized name. This pass catches one event scraped
  // under different names (e.g. the Eunos coffee-shop closure logged five times as
  // "Eunos Canteen" / "Unnamed Eunos Coffee Shop" / "友诺士咖啡店业者"). Signal: two
  // near-date, same-industry entries with different companies that share a token
  // rare across the whole dataset (a location/brand, not generic layoff vocab).
  const tokenSets = entries.map(significantTokens);
  const tokenDf = new Map<string, number>();
  for (const set of tokenSets) {
    for (const t of set) tokenDf.set(t, (tokenDf.get(t) ?? 0) + 1);
  }
  const seenPair = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (a.status === 'reference') continue;
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (b.status === 'reference') continue;
      if (a.industry !== b.industry) continue;
      if (
        normalizeCompany(a.company).toLowerCase() ===
        normalizeCompany(b.company).toLowerCase()
      ) {
        continue; // same-company repeats are handled by the loop above
      }
      const msPerDay = 1000 * 60 * 60 * 24;
      const da = new Date(a.date_announced).getTime();
      const db = new Date(b.date_announced).getTime();
      if (!Number.isFinite(da) || !Number.isFinite(db)) continue;
      if (Math.abs(db - da) > SAME_EVENT_WINDOW_DAYS * msPerDay) continue;

      const shared: string[] = [];
      for (const t of tokenSets[i]) {
        if (tokenSets[j].has(t) && (tokenDf.get(t) ?? 0) <= SAME_EVENT_RARE_DF_MAX) {
          shared.push(t);
        }
      }
      if (shared.length === 0) continue;

      const pairKey = `${i}|${j}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      warnings.push({
        rows: [i + 1, j + 1],
        type: 'possible-same-event',
        message: `Possible same event under different names: "${a.company}" (${a.date_announced}) and "${b.company}" (${b.date_announced}) share distinctive token(s) [${shared.join(', ')}]`,
      });
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

  const now = today();

  // Same underlying article cited by more than one row — a duplicate the
  // company+7-day window misses when the rows are far apart in time (e.g. the same
  // Vulcan Post story used for a 2024 and a 2026 Partior entry).
  const bySource = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const u = normalizeUrl(String(entries[i].source_link ?? ''));
    if (!u) continue;
    if (!bySource.has(u)) bySource.set(u, []);
    bySource.get(u)!.push(i + 1);
  }
  for (const [url, rows] of bySource) {
    if (rows.length > 1) {
      warnings.push({
        rows,
        type: 'duplicate-source',
        message: `Same article cited by ${rows.length} rows: ${url}`,
      });
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const notes = String(e.notes ?? '');

    // A date in the future can't be an event that "already happened". Usually the
    // scraper grabbed an article's publication date or a planned closure date.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(e.date_announced)) && e.date_announced > now) {
      warnings.push({
        rows: [i + 1],
        type: 'future-date',
        message: `Future date: "${e.company}" dated ${e.date_announced} (after ${now})`,
      });
    }

    // Confirmed entry that doesn't name a specific company.
    if (e.status === 'confirmed' && VAGUE_COMPANY.test(e.company)) {
      warnings.push({
        rows: [i + 1],
        type: 'vague-company',
        message: `Vague company for confirmed entry: "${e.company}" — name a specific company or downgrade`,
      });
    }

    // Confirmed entry whose own notes hedge (plan/unconfirmed/duplicate).
    if (e.status === 'confirmed' && HEDGE_NOTES.test(notes)) {
      warnings.push({
        rows: [i + 1],
        type: 'contradictory-verdict',
        message: `Confirmed but notes hedge: "${e.company}" (${e.date_announced}) — "${notes.slice(0, 90)}"`,
      });
    }

    // Confirmed entry carrying a global headcount — inflates totalJobsCut, which is
    // SG-specific. Flag so the figure can be cleared or scoped to Singapore.
    if (e.status === 'confirmed' && e.jobs_cut != null && e.jobs_cut >= 1000 && GLOBAL_FIGURE.test(notes)) {
      warnings.push({
        rows: [i + 1],
        type: 'global-figure',
        message: `Global figure on confirmed entry: "${e.company}" jobs_cut=${e.jobs_cut} reads as worldwide — counted into SG totalJobsCut`,
      });
    }
  }

  return warnings;
}

// Cross-file consistency: an event kept in layoffs.csv (confirmed/rumored) must not
// also sit in rejected.csv. The same real-world article surfacing in both files means
// the pipeline gave one event two opposite verdicts — exactly the Lou Shang failure
// (kept confirmed AND rumored while also rejected as "not-sg"). Matched on normalized
// source URL and on the [gn:...] Google-News fingerprint, so a re-wrapped RSS URL still
// links the two. Distinct sources for the same event (a deliberate dedup-suppression
// row pointing at a different outlet) don't collide and aren't flagged.
export function checkCrossFileContradictions(
  active: LayoffEntry[],
  rejected: LayoffEntry[]
): IntegrityWarning[] {
  const warnings: IntegrityWarning[] = [];

  const rejectedUrls = new Map<string, number>();
  const rejectedFps = new Map<string, number>();
  for (let i = 0; i < rejected.length; i++) {
    const notes = String(rejected[i].notes ?? '');
    // Skip duplicate-suppression rows: a rejected row logged as a "duplicate" of a kept
    // entry deliberately mirrors that entry's URL/fingerprint to block re-scraping — it
    // agrees with the verdict rather than contradicting it. Only substantive rejections
    // (not-sg, commentary, not-layoff, personal, …) constitute a real contradiction.
    if (/duplicate/i.test(notes)) continue;
    const u = normalizeUrl(String(rejected[i].source_link ?? ''));
    if (u && !rejectedUrls.has(u)) rejectedUrls.set(u, i + 1);
    const fp = extractGnFingerprint(notes);
    if (fp && !rejectedFps.has(fp)) rejectedFps.set(fp, i + 1);
  }

  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    const u = normalizeUrl(String(e.source_link ?? ''));
    const fp = extractGnFingerprint(String(e.notes ?? ''));
    const hit =
      (u && rejectedUrls.has(u) && { by: 'source URL', row: rejectedUrls.get(u)! }) ||
      (fp && rejectedFps.has(fp) && { by: 'gn-fingerprint', row: rejectedFps.get(fp)! });
    if (hit) {
      warnings.push({
        rows: [i + 1],
        type: 'cross-file-contradiction',
        message: `"${e.company}" (${e.date_announced}, ${e.status}) shares its ${hit.by} with rejected.csv row ${hit.row} — same event kept and rejected`,
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

  // When validating the active dataset, also cross-check against rejected.csv.
  if (filename === 'layoffs.csv') {
    try {
      const rejected = readCsv('rejected.csv');
      warnings.push(...checkCrossFileContradictions(entries, rejected));
    } catch {
      // rejected.csv is optional — skip the cross-check if it isn't present.
    }
  }

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

// CLI entry point — only when run directly (tsx scripts/validate.ts), not when
// imported by another script (e.g. scripts/llm-evals.ts reuses the predicates).
if (process.argv[1]?.endsWith('validate.ts')) {
  const file = process.argv[3] || 'layoffs.csv';
  const { valid } = validateCsv(file);
  // Exit non-zero on hard errors so CI actually gates on this. The scheduled-scrape
  // workflow uses `npm run validate` as its only pre-commit data check (it does not
  // run the test suite), so without this a corrupted row would log an error but the
  // job would still succeed and auto-commit it to main. Integrity *warnings* leave
  // `valid` true and do not block — they stay advisory by design.
  if (!valid) process.exit(1);
}
