import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Papa from 'papaparse';
import { readCsv } from '../src/lib/csv';
import { LayoffEntry, INDUSTRIES } from '../src/lib/types';
import { companyKey } from './normalize';
import { daysBetween, todayIso } from '../src/lib/dates';
import { extractGnFingerprint } from './deduplicate';
import { normalizeUrl } from './url-normalize';
import { DOUBLE_COUNT_REVIEW_WINDOW_DAYS, SAME_EVENT_WINDOW_DAYS } from './same-event';

const SUPERSEDED_RUMOR_WINDOW_DAYS = 30;
const PER_ROW_EXAMPLE_LIMIT = 5;

interface ValidationError {
  row: number;
  field: string;
  message: string;
}

export type IntegrityWarningType =
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
  | 'possible-same-event'
  | 'same-day-same-event';

export interface IntegrityWarning {
  type: IntegrityWarningType;
  eventIds: string[];
  rows: number[];
  identity: string;
  message: string;
}

// Integrity finding types that are promoted to hard errors (block `npm run validate`
// with exit 1) rather than staying advisory. Currently just the high-confidence
// same-day subset of the cross-name same-event detection — see
// 'same-day-same-event' in findCrossNamePairs for what qualifies.
const HARD_INTEGRITY_ERROR_TYPES = new Set<IntegrityWarningType>(['same-day-same-event']);

const PER_ROW_ADVISORY_TYPES = new Set<IntegrityWarningType>([
  'unarchived-confirmed',
  'contradictory-verdict',
  'global-figure',
  'vague-company',
  'cross-file-contradiction',
]);

const NUMERIC_COLUMNS = {
  jobs_cut_sg: true,
  jobs_cut_global: true,
  pct_workforce: true,
} as const;

// Today in YYYY-MM-DD. Overridable via VALIDATE_TODAY so tests are deterministic.
function today(): string {
  return process.env.VALIDATE_TODAY || todayIso();
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
  // Generic F&B/retail venue words that recur across many unrelated small
  // businesses ("Pantler Patisserie" vs "Flor Patisserie", "Laurent Cafe" vs
  // "Fika Swedish Cafe", "Korea Artiz Studio" vs "Korean Wedding Studio"). These
  // caused false "same event" matches before being added here — only a shared
  // token from the distinctive part of the name (the brand/proper noun) should
  // count, never the generic category word attached to it.
  'patisserie', 'cafe', 'studio',
]);

// A significant token appearing in at most this many entries is treated as
// distinctive enough (a location, brand, or unusual word) that two near-date
// entries sharing it likely describe the same event.
const SAME_EVENT_RARE_DF_MAX = 5;

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

  if (
    entry.date_reported !== null &&
    entry.date_reported !== undefined &&
    String(entry.date_reported).trim() !== '' &&
    !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date_reported))
  ) {
    errors.push({ row: r, field: 'date_reported', message: 'Date must be YYYY-MM-DD or empty' });
  }

  for (const field of ['jobs_cut_sg', 'jobs_cut_global'] as const) {
    const v = entry[field];
    if (v !== null && v !== undefined && v !== ('' as any)) {
      if (typeof v !== 'number' || v < 0) {
        errors.push({ row: r, field, message: 'Must be a positive number or empty' });
      }
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

  const validStatuses = ['rumored', 'confirmed', 'reference', 'denied', 'expired'];
  if (!validStatuses.includes(entry.status)) {
    errors.push({ row: r, field: 'status', message: `Must be one of: ${validStatuses.join(', ')}` });
  }

  if (!entry.source_link || String(entry.source_link).trim() === '') {
    errors.push({ row: r, field: 'source_link', message: 'Source link is required' });
  }

  if (!entry.event_id || String(entry.event_id).trim() === '') {
    errors.push({ row: r, field: 'event_id', message: 'Event id is required' });
  }

  return errors;
}

interface IndexedEntry {
  row: number;
  entry: LayoffEntry;
  eventId: string;
}

interface PairFinding {
  type: IntegrityWarningType;
  first: IndexedEntry;
  second: IndexedEntry;
  days: number;
  sharedTokens: string[];
}

interface PairGroup {
  type: IntegrityWarningType;
  firstId: string;
  secondId: string;
  rows: Set<number>;
  companies: Set<string>;
  minDays: number;
  sharedTokens: Set<string>;
}

export function eventIdOf(entry: LayoffEntry, row: number): string {
  const id = String(entry.event_id ?? '').trim();
  return id || `row-${row}`;
}

function indexEntries(entries: LayoffEntry[]): IndexedEntry[] {
  return entries.map((entry, i) => ({ row: i + 1, entry, eventId: eventIdOf(entry, i + 1) }));
}

function earliestDateByEvent(indexed: IndexedEntry[]): Map<string, string> {
  const earliest = new Map<string, string>();
  for (const { eventId, entry } of indexed) {
    const date = String(entry.date_announced ?? '');
    const current = earliest.get(eventId);
    if (current === undefined || date < current) earliest.set(eventId, date);
  }
  return earliest;
}

export function eventPairKey(a: string, b: string): string {
  return [a, b].sort().join(' + ');
}

export function rowIdentity(entry: LayoffEntry): string {
  const url = normalizeUrl(String(entry.source_link ?? ''));
  return url || `${companyKey(String(entry.company ?? ''))}@${entry.date_announced}`;
}

export function warningFingerprint(warning: IntegrityWarning): string {
  return `${warning.type} :: ${warning.identity}`;
}

export function parseDistinctEventPairs(raw: string): Set<string> {
  const rows = Papa.parse<Record<string, string>>(raw.replace(/\r\n?/g, '\n'), {
    header: true,
    skipEmptyLines: true,
  }).data;
  const pairs = new Set<string>();
  for (const row of rows) {
    const a = String(row.event_id_a ?? '').trim();
    const b = String(row.event_id_b ?? '').trim();
    if (a && b) pairs.add(eventPairKey(a, b));
  }
  return pairs;
}

export function readDistinctEventPairs(
  filePath = path.join(process.cwd(), 'data', 'distinct-events.csv')
): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  return parseDistinctEventPairs(fs.readFileSync(filePath, 'utf-8'));
}

export function parseLayoffEntries(raw: string): LayoffEntry[] {
  return Papa.parse<LayoffEntry>(raw.replace(/\r\n?/g, '\n'), {
    header: true,
    dynamicTyping: NUMERIC_COLUMNS,
    skipEmptyLines: true,
  }).data;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}

function dayGap(a: IndexedEntry, b: IndexedEntry): number {
  return Math.round(daysBetween(a.entry.date_announced, b.entry.date_announced));
}

function classifySameCompanyPair(a: IndexedEntry, b: IndexedEntry): PairFinding[] {
  const days = dayGap(a, b);
  const finding = (type: IntegrityWarningType): PairFinding => ({ type, first: a, second: b, days, sharedTokens: [] });
  const findings: PairFinding[] = [];
  const bothConfirmed = a.entry.status === 'confirmed' && b.entry.status === 'confirmed';

  if (days === 0) {
    findings.push(finding('duplicate'));
  } else if (days <= DOUBLE_COUNT_REVIEW_WINDOW_DAYS && bothConfirmed) {
    // Two confirmed entries for the same company within a month often reflect the
    // same event covered in two articles dated days/weeks apart.
    findings.push(finding('double-count'));
  }

  if (a.entry.status === 'rumored' && b.entry.status === 'confirmed' && days >= 0 && days <= SUPERSEDED_RUMOR_WINDOW_DAYS) {
    findings.push(finding('superseded-rumor'));
  }
  return findings;
}

// Rows that share an event_id are follow-up coverage of ONE event (that is what
// event_id records), so only pairs spanning two event_ids are compared.
function findSameCompanyPairs(indexed: IndexedEntry[]): PairFinding[] {
  const findings: PairFinding[] = [];
  for (const group of groupBy(indexed, (x) => companyKey(x.entry.company)).values()) {
    group.sort((a, b) => a.entry.date_announced.localeCompare(b.entry.date_announced));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].eventId === group[j].eventId) continue;
        findings.push(...classifySameCompanyPair(group[i], group[j]));
      }
    }
  }
  return findings;
}

function sharedRareTokens(a: Set<string>, b: Set<string>, tokenDf: Map<string, number>): string[] {
  return [...a].filter((t) => b.has(t) && (tokenDf.get(t) ?? 0) <= SAME_EVENT_RARE_DF_MAX);
}

function documentFrequency(tokenSets: Set<string>[]): Map<string, number> {
  const tokenDf = new Map<string, number>();
  for (const set of tokenSets) {
    for (const t of set) tokenDf.set(t, (tokenDf.get(t) ?? 0) + 1);
  }
  return tokenDf;
}

function isCrossNameCandidate(a: IndexedEntry, b: IndexedEntry): boolean {
  if (a.entry.status === 'reference' || b.entry.status === 'reference') return false;
  if (a.entry.industry !== b.entry.industry) return false;
  if (companyKey(a.entry.company) === companyKey(b.entry.company)) return false;
  return a.eventId !== b.eventId;
}

function sameDayHardError(a: IndexedEntry, b: IndexedEntry, shared: string[]): IntegrityWarning {
  return {
    type: 'same-day-same-event',
    eventIds: [a.eventId, b.eventId],
    rows: [a.row, b.row],
    identity: eventPairKey(a.eventId, b.eventId),
    message: `Same-day, same-industry entries share distinctive company token(s) [${shared.join(', ')}]: "${a.entry.company}" and "${b.entry.company}" both on ${a.entry.date_announced} — if this is one event, give both rows the same event_id; if they are genuinely different companies, add an alias/exclusion so this token stops matching`,
  };
}

// Cross-name same-event double-count: the company-keyed pass only catches repeats
// under the *same* normalized name. This pass catches one event scraped under
// different names (e.g. the Eunos coffee-shop closure logged five times as
// "Eunos Canteen" / "Unnamed Eunos Coffee Shop" / "友诺士咖啡店业者"). Signal: two
// near-date, same-industry entries with different companies that share a token
// rare across the whole dataset (a location/brand, not generic layoff vocab).
// Identical date + industry + shared rare token + no shared event_id is treated as
// certain enough to be a hard error rather than an advisory warning.
function findCrossNamePairs(indexed: IndexedEntry[]): { hardErrors: IntegrityWarning[]; findings: PairFinding[] } {
  const tokenSets = indexed.map((x) => significantTokens(x.entry));
  const tokenDf = documentFrequency(tokenSets);
  const hardErrors: IntegrityWarning[] = [];
  const findings: PairFinding[] = [];

  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      const a = indexed[i];
      const b = indexed[j];
      if (!isCrossNameCandidate(a, b)) continue;
      const days = dayGap(a, b);
      if (!Number.isFinite(days) || days > SAME_EVENT_WINDOW_DAYS) continue;
      const shared = sharedRareTokens(tokenSets[i], tokenSets[j], tokenDf);
      if (shared.length === 0) continue;

      if (days === 0) hardErrors.push(sameDayHardError(a, b, shared));
      else findings.push({ type: 'possible-same-event', first: a, second: b, days, sharedTokens: shared });
    }
  }
  return { hardErrors, findings };
}

function groupPairFindings(findings: PairFinding[]): PairGroup[] {
  const groups = new Map<string, PairGroup>();
  for (const f of findings) {
    const key = `${f.type} :: ${eventPairKey(f.first.eventId, f.second.eventId)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        type: f.type,
        firstId: f.first.eventId,
        secondId: f.second.eventId,
        rows: new Set(),
        companies: new Set(),
        minDays: f.days,
        sharedTokens: new Set(),
      };
      groups.set(key, group);
    }
    group.rows.add(f.first.row).add(f.second.row);
    group.companies.add(String(f.first.entry.company)).add(String(f.second.entry.company));
    group.minDays = Math.min(group.minDays, f.days);
    for (const t of f.sharedTokens) group.sharedTokens.add(t);
  }
  return [...groups.values()];
}

export function formatRows(rows: number[]): string {
  const sorted = [...rows].sort((a, b) => a - b);
  if (sorted.length <= 3) return `rows ${sorted.join(', ')}`;
  return `rows ${sorted[0]} + ${sorted.length - 1} others`;
}

function formatCompanies(companies: Set<string>): string {
  const names = [...companies].map((c) => `"${c}"`);
  if (names.length <= 3) return names.join(' / ');
  return `${names.slice(0, 3).join(' / ')} + ${names.length - 3} more names`;
}

function pairMessage(group: PairGroup, earliest: Map<string, string>): string {
  const describe = (id: string) => `${id} (from ${earliest.get(id)})`;
  const companies = formatCompanies(group.companies);
  const sides = `${describe(group.firstId)} vs ${describe(group.secondId)}`;
  const where = formatRows([...group.rows]);
  switch (group.type) {
    case 'duplicate':
      return `Duplicate: ${companies} on the same date under two event_ids — ${sides}; ${where}`;
    case 'double-count':
      return `Possible double-count: ${companies} confirmed under two event_ids — ${sides}, closest rows ${group.minDays}d apart; ${where}`;
    case 'superseded-rumor':
      return `Superseded rumor: ${companies} rumored ${describe(group.firstId)} precedes confirmed ${describe(group.secondId)} by ${group.minDays}d; ${where}`;
    default:
      return `Possible same event under different names: ${companies} share distinctive token(s) [${[...group.sharedTokens].join(', ')}] — ${sides}, ${group.minDays}d apart; ${where}`;
  }
}

function orientByEarliest(group: PairGroup, earliest: Map<string, string>): PairGroup {
  if (group.type === 'superseded-rumor') return group;
  const firstDate = earliest.get(group.firstId) ?? '';
  const secondDate = earliest.get(group.secondId) ?? '';
  if (firstDate <= secondDate) return group;
  return { ...group, firstId: group.secondId, secondId: group.firstId };
}

function toPairWarning(unoriented: PairGroup, earliest: Map<string, string>): IntegrityWarning {
  const group = orientByEarliest(unoriented, earliest);
  return {
    type: group.type,
    eventIds: [group.firstId, group.secondId],
    rows: [...group.rows].sort((a, b) => a - b),
    identity: eventPairKey(group.firstId, group.secondId),
    message: pairMessage(group, earliest),
  };
}

function rowWarning(type: IntegrityWarningType, item: IndexedEntry, message: string): IntegrityWarning {
  return { type, eventIds: [item.eventId], rows: [item.row], identity: rowIdentity(item.entry), message };
}

function findUnarchivedConfirmed(indexed: IndexedEntry[]): IntegrityWarning[] {
  return indexed
    .filter(({ entry }) => entry.status === 'confirmed' && !isReputableSource(String(entry.source_link ?? '')))
    .map((item) =>
      rowWarning(
        'unarchived-confirmed',
        item,
        `Unrecognised source for confirmed entry: "${item.entry.company}" (${item.entry.date_announced}) — ${item.entry.source_link}`
      )
    );
}

// Same underlying article cited by more than one row — a duplicate the company
// window misses when the rows are far apart in time (e.g. the same Vulcan Post
// story used for a 2024 and a 2026 Partior entry).
function findDuplicateSources(indexed: IndexedEntry[]): IntegrityWarning[] {
  const bySource = groupBy(
    indexed.filter((x) => normalizeUrl(String(x.entry.source_link ?? ''))),
    (x) => normalizeUrl(String(x.entry.source_link ?? ''))
  );
  const warnings: IntegrityWarning[] = [];
  for (const [url, items] of bySource) {
    if (items.length < 2) continue;
    const rows = items.map((x) => x.row);
    warnings.push({
      type: 'duplicate-source',
      eventIds: [...new Set(items.map((x) => x.eventId))].sort(),
      rows,
      identity: url,
      message: `Same article cited by ${rows.length} rows (${formatRows(rows)}): ${url}`,
    });
  }
  return warnings;
}

function perRowAdvisories(item: IndexedEntry, now: string): IntegrityWarning[] {
  const e = item.entry;
  const notes = String(e.notes ?? '');
  const confirmed = e.status === 'confirmed';
  const warnings: IntegrityWarning[] = [];

  // A date in the future can't be an event that "already happened". Usually the
  // scraper grabbed an article's publication date or a planned closure date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(e.date_announced)) && e.date_announced > now) {
    warnings.push(rowWarning('future-date', item, `Future date: "${e.company}" dated ${e.date_announced} (after ${now})`));
  }

  if (confirmed && VAGUE_COMPANY.test(e.company)) {
    warnings.push(
      rowWarning('vague-company', item, `Vague company for confirmed entry: "${e.company}" — name a specific company or downgrade`)
    );
  }

  if (confirmed && HEDGE_NOTES.test(notes)) {
    warnings.push(
      rowWarning('contradictory-verdict', item, `Confirmed but notes hedge: "${e.company}" (${e.date_announced}) — "${notes.slice(0, 90)}"`)
    );
  }

  // jobs_cut_sg feeds totalJobsCut, so a worldwide number parked in that column
  // inflates the SG headline. (A global figure belongs in jobs_cut_global.)
  if (confirmed && e.jobs_cut_sg != null && e.jobs_cut_sg >= 1000 && GLOBAL_FIGURE.test(notes)) {
    warnings.push(
      rowWarning(
        'global-figure',
        item,
        `Global figure in jobs_cut_sg: "${e.company}" jobs_cut_sg=${e.jobs_cut_sg} reads as worldwide — move to jobs_cut_global`
      )
    );
  }
  return warnings;
}

export function checkIntegrity(
  entries: LayoffEntry[],
  distinctPairs: Set<string> = readDistinctEventPairs()
): IntegrityWarning[] {
  const indexed = indexEntries(entries);
  const earliest = earliestDateByEvent(indexed);
  const crossName = findCrossNamePairs(indexed);
  const pairWarnings = groupPairFindings([...findSameCompanyPairs(indexed), ...crossName.findings])
    .filter((group) => !distinctPairs.has(eventPairKey(group.firstId, group.secondId)))
    .map((group) => toPairWarning(group, earliest));
  const now = today();

  return [
    ...pairWarnings,
    ...crossName.hardErrors,
    ...findUnarchivedConfirmed(indexed),
    ...findDuplicateSources(indexed),
    ...indexed.flatMap((item) => perRowAdvisories(item, now)),
  ];
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
        type: 'cross-file-contradiction',
        eventIds: [eventIdOf(e, i + 1)],
        rows: [i + 1],
        identity: rowIdentity(e),
        message: `"${e.company}" (${e.date_announced}, ${e.status}) shares its ${hit.by} with rejected.csv row ${hit.row} — same event kept and rejected`,
      });
    }
  }

  return warnings;
}

export interface DatasetAnalysis {
  errors: ValidationError[];
  hardIntegrityErrors: IntegrityWarning[];
  warnings: IntegrityWarning[];
}

export function analyzeDataset(
  entries: LayoffEntry[],
  rejected: LayoffEntry[] | null,
  distinctPairs: Set<string>
): DatasetAnalysis {
  const errors = entries.flatMap((entry, i) => validateEntry(entry, i));
  const findings = checkIntegrity(entries, distinctPairs);
  if (rejected) findings.push(...checkCrossFileContradictions(entries, rejected));
  return {
    errors,
    hardIntegrityErrors: findings.filter((w) => HARD_INTEGRITY_ERROR_TYPES.has(w.type)),
    warnings: findings.filter((w) => !HARD_INTEGRITY_ERROR_TYPES.has(w.type)),
  };
}

export interface EventStats {
  rows: number;
  events: number;
  confirmedEvents: number;
}

export function eventStats(entries: LayoffEntry[]): EventStats {
  const indexed = indexEntries(entries);
  const confirmed = indexed.filter((x) => x.entry.status === 'confirmed');
  return {
    rows: entries.length,
    events: new Set(indexed.map((x) => x.eventId)).size,
    confirmedEvents: new Set(confirmed.map((x) => x.eventId)).size,
  };
}

function rowLabel(warning: IntegrityWarning): string {
  if (warning.rows.length === 1) return `Row ${warning.rows[0]}: `;
  return '';
}

function printErrors(filename: string, analysis: DatasetAnalysis): void {
  const { errors, hardIntegrityErrors } = analysis;
  if (errors.length === 0 && hardIntegrityErrors.length === 0) return;
  console.error(`❌ ${filename}: ${errors.length + hardIntegrityErrors.length} validation error(s):`);
  for (const err of errors) {
    console.error(`  Row ${err.row}, ${err.field}: ${err.message}`);
  }
  for (const err of hardIntegrityErrors) {
    console.error(`  [${err.type}] Rows ${err.rows.join(' & ')}: ${err.message}`);
  }
}

function printWarnings(filename: string, warnings: IntegrityWarning[], verbose: boolean): void {
  if (warnings.length === 0) return;
  console.warn(`\n⚠️  ${filename}: ${warnings.length} integrity warning(s):`);
  for (const [type, list] of groupBy(warnings, (w) => w.type)) {
    const truncate = !verbose && PER_ROW_ADVISORY_TYPES.has(type as IntegrityWarningType);
    const shown = truncate ? list.slice(0, PER_ROW_EXAMPLE_LIMIT) : list;
    console.warn(`\n  [${type}] ${list.length}`);
    for (const w of shown) console.warn(`    ${rowLabel(w)}${w.message}`);
    if (shown.length < list.length) {
      console.warn(`    … ${list.length - shown.length} more (pass --verbose to list all)`);
    }
  }
}

function printSummary(filename: string, entries: LayoffEntry[], analysis: DatasetAnalysis): void {
  const counts = new Map<string, number>();
  for (const w of [...analysis.hardIntegrityErrors, ...analysis.warnings]) {
    counts.set(w.type, (counts.get(w.type) ?? 0) + 1);
  }
  const lines: [string, number][] = [
    ['validation errors', analysis.errors.length],
    ...[...counts].sort((a, b) => b[1] - a[1]),
    ['total warnings', analysis.warnings.length],
  ];
  const width = Math.max(...lines.map(([label]) => label.length));
  const stats = eventStats(entries);
  console.log(`\nSummary — ${filename}`);
  for (const [label, count] of lines) console.log(`  ${label.padEnd(width)}  ${String(count).padStart(5)}`);
  console.log(`  rows ${stats.rows} | distinct event_ids ${stats.events} | confirmed distinct events ${stats.confirmedEvents}`);
}

export function validateCsv(
  filename: string,
  options: { verbose?: boolean } = {}
): { valid: boolean; errors: ValidationError[]; warnings: IntegrityWarning[] } {
  const entries = readCsv(filename);
  const rejected = filename === 'layoffs.csv' ? readCsv('rejected.csv') : null;
  const analysis = analyzeDataset(entries, rejected, readDistinctEventPairs());
  const valid = analysis.errors.length === 0 && analysis.hardIntegrityErrors.length === 0;

  if (valid && analysis.warnings.length === 0) {
    console.log(`✅ ${filename}: All ${entries.length} entries valid.`);
  } else {
    printErrors(filename, analysis);
    printWarnings(filename, analysis.warnings, options.verbose ?? false);
  }
  printSummary(filename, entries, analysis);

  return { valid, errors: analysis.errors, warnings: analysis.warnings };
}

function gitShow(ref: string, relativePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:./${relativePath}`], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function assertGitRef(ref: string): void {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
  } catch {
    throw new Error(`--baseline: "${ref}" is not a valid git ref`);
  }
}

export function warningsAtRef(ref: string, filename: string): IntegrityWarning[] {
  assertGitRef(ref);
  const raw = gitShow(ref, `data/${filename}`);
  if (raw === null) return [];
  const rejectedRaw = filename === 'layoffs.csv' ? gitShow(ref, 'data/rejected.csv') : null;
  const distinctRaw = gitShow(ref, 'data/distinct-events.csv');
  return analyzeDataset(
    parseLayoffEntries(raw),
    rejectedRaw === null ? null : parseLayoffEntries(rejectedRaw),
    distinctRaw === null ? new Set() : parseDistinctEventPairs(distinctRaw)
  ).warnings;
}

export function newWarnings(current: IntegrityWarning[], baseline: IntegrityWarning[]): IntegrityWarning[] {
  const known = new Set(baseline.map(warningFingerprint));
  return current.filter((w) => !known.has(warningFingerprint(w)));
}

function reportBaselineRegressions(filename: string, ref: string, current: IntegrityWarning[]): IntegrityWarning[] {
  const baseline = warningsAtRef(ref, filename);
  const added = newWarnings(current, baseline);
  const resolved = newWarnings(baseline, current).length;
  console.log(
    `\nBaseline ${ref}: ${baseline.length} warning(s) then, ${current.length} now — ${added.length} new, ${resolved} resolved`
  );
  if (added.length === 0) return added;
  console.error(`❌ ${added.length} integrity warning(s) are new relative to ${ref}:`);
  for (const w of added) console.error(`  [${w.type}] ${rowLabel(w)}${w.message}`);
  return added;
}

interface CliOptions {
  file: string;
  verbose: boolean;
  baselineRef: string | null;
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { file: 'layoffs.csv', verbose: false, baselineRef: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verbose') options.verbose = true;
    else if (arg === '--baseline') options.baselineRef = args[++i] ?? null;
    else if (arg.startsWith('--baseline=')) options.baselineRef = arg.slice('--baseline='.length);
    else if (!arg.startsWith('--')) options.file = arg;
  }
  if (args.includes('--baseline') && !options.baselineRef) {
    throw new Error('--baseline requires a git ref, e.g. --baseline HEAD');
  }
  return options;
}

// CLI entry point — only when run directly (tsx scripts/validate.ts), not when
// imported by another script (e.g. scripts/llm-evals.ts reuses the predicates).
function main(): number {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.baselineRef) assertGitRef(options.baselineRef);
  const { valid, warnings } = validateCsv(options.file, { verbose: options.verbose });
  const regressions = options.baselineRef ? reportBaselineRegressions(options.file, options.baselineRef, warnings) : [];
  return valid && regressions.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('validate.ts')) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
