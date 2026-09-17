import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { INDUSTRIES } from '../src/lib/types';

// A small in-code fallback used only if data/company-aliases.csv is missing (e.g. a
// fresh checkout that hasn't pulled data/, or a sandboxed test run with a stripped-down
// data dir). The CSV is the source of truth — see loadCompanyAliases() below — so this
// fallback is intentionally minimal, not a full mirror of the CSV.
const FALLBACK_ALIASES: Record<string, string> = {
  'dbs bank': 'DBS',
  'sea limited': 'Sea',
  "yeo's": 'Yeo Hiap Seng',
  'ninja van': 'Ninja Van',
};

// Company aliases live in data/company-aliases.csv (header: alias,canonical,note) so a
// future audit can append a row without touching this file. Loaded synchronously at
// module init — every caller (scrape/dedup/cluster/validate scripts, tests) imports
// normalizeCompany well before any async work starts, so a sync read keeps the API
// simple and avoids threading an init step through every call site.
//
// NOTE: do NOT add self-mapping "X Singapore" -> "X Singapore" rows to the CSV. The
// alias lookup returns before suffix-stripping, so a self-map would prevent the
// 'singapore' suffix (below) from collapsing the SG-office row and the parent-company
// row of the same event into one key -- splitting it across two rows. Let "BioNTech
// Singapore"/"ExxonMobil Singapore" fall through to suffix-stripping instead.
function loadCompanyAliases(): Record<string, string> {
  const filePath = path.join(process.cwd(), 'data', 'company-aliases.csv');
  if (!fs.existsSync(filePath)) return { ...FALLBACK_ALIASES };

  const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n');
  const parsed = Papa.parse<{ alias: string; canonical: string; note?: string }>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  const map: Record<string, string> = {};
  for (const row of parsed.data) {
    const alias = String(row.alias ?? '').trim().toLowerCase();
    const canonical = String(row.canonical ?? '').trim();
    if (!alias || !canonical) continue;
    map[alias] = canonical;
  }
  return Object.keys(map).length > 0 ? map : { ...FALLBACK_ALIASES };
}

const COMPANY_ALIASES: Record<string, string> = loadCompanyAliases();

const SUFFIXES = [
  'pte ltd',
  'pte. ltd.',
  'pte ltd.',
  'ltd',
  'ltd.',
  'limited',
  'inc',
  'inc.',
  'corp',
  'corp.',
  'corporation',
  'holdings',
  'group',
  'singapore',
  'international',
];

// Trailing generic business descriptors, stripped AFTER the corporate suffixes above.
// These collapse brand/parent surface variants ("Meta Platforms" -> "Meta",
// "Japan Home Stores" -> "Japan Home", "Heineken Asia Pacific" -> "Heineken") without
// touching words in the middle of a name. Deliberately conservative: every entry here
// is a word (or fixed phrase) that only ever adds a generic qualifier, never a
// company's actual identity -- words like "beer", "home" or a bare "bar" are left out
// on purpose so "Tiger Beer" doesn't become "Tiger" and "Japan Home" doesn't become
// "Japan". Every pattern below is anchored with a leading `\s+`, so a descriptor can
// only strip when something precedes it -- a bare "Sea" or "Cafe" is left untouched.
//
// NOTE: standalone "asia"/"apac" are deliberately NOT in this list, even though a
// regional-office suffix is the intended target ("Heineken Asia Pacific" -> Heineken).
// Real, distinct companies in this dataset end in a bare "Asia" as part of their actual
// name (e.g. "Jetstar Asia", "CJ Logistics Asia"), so stripping a lone trailing "Asia"
// would wrongly collapse them into their region-less prefix. The two-word "Asia
// Pacific" phrase is a safer, more specific trailing descriptor and covers the live
// Heineken pair without touching any single-word "... Asia" company name.
//
// NOTE: "technologies"/"technology"/"tech" are also deliberately NOT in this list.
// They would collapse "Uber Technologies" into "Uber" — but tests/validate.ts's
// cross-name token check (see 'same-day-same-event' in checkIntegrity) uses exactly
// that pair as its regression example for a *different*, already-shipped safety net:
// two same-day, same-industry rows sharing a distinctive token are hard-errored so a
// human links them via event_id. Merging the pair here would route them through the
// same-company 'duplicate' path instead and silently defeat that check. See the
// "Uber" / "Uber Technologies" entry in tests/known-duplicates.test.ts's
// knownDistinctPairs for the pinned regression.
const GENERIC_TRAILING_DESCRIPTORS = [
  'platforms',
  'asia pacific',
  'stores',
  'store',
  'patisserie',
  'cafe',
  'restaurant',
  'bakery',
  'bar and grill',
  'bistro',
  'eatery',
  'kitchen',
  'studio',
];

// Unicode-fold a name so accent/diacritic variants collapse ("Café" == "Cafe"),
// normalize curly apostrophes to a plain one, treat "&" the same as "and" when it's
// used as a spaced word-joiner (but leave a tight "H&M"-style abbreviation alone), and
// collapse whitespace. Runs before anything else so every later step (alias lookup,
// suffix-strip) sees one consistent surface form.
function foldUnicodeAndPunctuation(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[‘’ʼ]/g, "'") // curly/modifier apostrophes -> '
    .replace(/\s&\s/g, ' and ') // " & " (spaced) -> " and "; "H&M" (unspaced) untouched
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompany(raw: string): string {
  let name = foldUnicodeAndPunctuation(raw);
  if (!name) return raw.trim();

  // Check known aliases first (exact lowercased match, parenthetical forms included).
  const lower = name.toLowerCase();
  if (COMPANY_ALIASES[lower]) return COMPANY_ALIASES[lower];

  // Strip a trailing parenthetical qualifier ("Shopee (Sea)" → "Shopee") so brand
  // variants collapse to one key. Runs AFTER the alias check, so explicitly-pinned
  // forms like "Sea Limited (Shopee)" resolve to their canonical brand first. Re-check
  // aliases on the stripped form to catch e.g. "DBS Bank (Singapore)" → "DBS".
  const deparen = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (deparen && deparen !== name) {
    name = deparen;
    if (COMPANY_ALIASES[name.toLowerCase()]) return COMPANY_ALIASES[name.toLowerCase()];
  }

  // Strip corporate suffixes (Pte Ltd, Holdings, Group, Singapore, ...).
  for (const suffix of SUFFIXES) {
    const re = new RegExp(`\\s+${suffix.replace(/\./g, '\\.')}$`, 'i');
    name = name.replace(re, '');
  }

  // Strip trailing generic descriptors (Platforms, Cafe, Bar and Grill, ...). The
  // `stripped !== name` check is a defensive no-op guard: the `\s+` anchor above
  // already guarantees a descriptor can never consume a whole (unprefixed) name, so
  // this never fires today, but it keeps the loop inert rather than destructive if a
  // future descriptor is added without that anchor.
  for (const descriptor of GENERIC_TRAILING_DESCRIPTORS) {
    const re = new RegExp(`\\s+${descriptor}$`, 'i');
    const stripped = name.replace(re, '').trim();
    if (stripped && stripped !== name) name = stripped;
  }

  // Strip trailing punctuation and extra whitespace
  name = name.replace(/[,;.]$/, '').trim();

  // Title case
  name = name
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  return name || raw.trim();
}

// Build a map of {canonicalKey -> word-bounded search variants} for matching
// a company inside a URL path or a degenerate (truncated) title. The canonical
// key collapses URL-style variants ("ninja-van", "ninjavan", "ninja van") so
// the clustering layer keys consistently.
//
// Variants are intended for word-bounded (` v `) search against a tokenized
// path surface (separators → spaces). Pure substring search is intentionally
// avoided to keep short tokens like "hm" (H&M) usable without false positives.
//
// Pass any additional company names beyond the alias table (typically the
// canonical names already in layoffs.csv).
export type CompanyTokenMap = Map<string, string[]>;

export function companyTokens(extraNames: string[] = []): CompanyTokenMap {
  const map: CompanyTokenMap = new Map();
  // Words that mean nothing on their own — never use them as a search variant.
  const GENERIC = new Set([
    'the', 'and', 'group', 'asia', 'sea', 'singapore', 'pacific', 'global', 'inc',
    'corp', 'ltd', 'limited', 'holdings',
  ]);

  const slugify = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const variantsFor = (slug: string): string[] => {
    const out = new Set<string>();
    out.add(slug);                           // "ninja van"
    out.add(slug.replace(/\s+/g, ''));       // "ninjavan"
    if (slug.includes(' ')) out.add(slug.replace(/\s+/g, '-')); // "ninja-van"
    const first = slug.split(/\s+/)[0];
    if (first.length >= 5 && !GENERIC.has(first)) out.add(first);
    return [...out].filter((v) => v.length > 0 && !GENERIC.has(v));
  };

  const add = (canonicalName: string, aliases: string[] = []) => {
    const norm = slugify(normalizeCompany(canonicalName));
    if (!norm) return;
    const key = norm.replace(/\s+/g, '-');
    if (GENERIC.has(key)) return;

    const all = new Set<string>(variantsFor(norm));
    for (const alias of aliases) {
      const aliasSlug = slugify(alias);
      if (!aliasSlug) continue;
      for (const v of variantsFor(aliasSlug)) all.add(v);
    }

    const existing = map.get(key);
    if (existing) {
      for (const v of all) if (!existing.includes(v)) existing.push(v);
    } else {
      map.set(key, [...all]);
    }
  };

  // Group aliases by their canonical name so each alias becomes an extra
  // search variant under the canonical key.
  const aliasGroups = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(COMPANY_ALIASES)) {
    const arr = aliasGroups.get(canonical) ?? [];
    arr.push(alias);
    aliasGroups.set(canonical, arr);
  }
  for (const [canonical, aliases] of aliasGroups) add(canonical, aliases);
  for (const n of extraNames) add(n);
  return map;
}

export function normalizeIndustry(raw: string): string {
  const lower = raw.toLowerCase().trim();

  const mappings: Record<string, string> = {
    tech: 'Tech',
    technology: 'Tech',
    it: 'Tech',
    'information technology': 'Tech',
    software: 'Tech',
    ecommerce: 'Tech',
    'e-commerce': 'Tech',
    fintech: 'Finance',
    finance: 'Finance',
    banking: 'Finance',
    'financial services': 'Finance',
    manufacturing: 'Manufacturing',
    retail: 'Retail',
    'f&b': 'F&B',
    'food & beverage': 'F&B',
    'food and beverage': 'F&B',
    'food & beverages': 'F&B',
    hospitality: 'F&B',
    'real estate': 'Real Estate',
    property: 'Real Estate',
    healthcare: 'Healthcare',
    medical: 'Healthcare',
    pharma: 'Healthcare',
    pharmaceutical: 'Healthcare',
    education: 'Education',
    edtech: 'Education',
    media: 'Other',
    logistics: 'Other',
    transport: 'Other',
    shipping: 'Other',
    energy: 'Other',
    construction: 'Other',
  };

  const mapped = mappings[lower];
  if (mapped) return mapped;

  // Fuzzy match
  for (const industry of INDUSTRIES) {
    if (lower.includes(industry.toLowerCase())) return industry;
  }

  return 'Other';
}

export function parseDate(raw: string): string | null {
  if (!raw) return null;

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  const cleaned = raw.trim().replace(/,/g, '');
  const d = new Date(cleaned);

  if (isNaN(d.getTime())) {
    // Try common formats: "15 May 2025", "May 15, 2025"
    const parts = cleaned.split(/\s+/);
    const monthMap: Record<string, number> = {
      jan: 0, january: 0,
      feb: 1, february: 1,
      mar: 2, march: 2,
      apr: 3, april: 3,
      may: 4,
      jun: 5, june: 5,
      jul: 6, july: 6,
      aug: 7, august: 7,
      sep: 8, september: 8,
      oct: 9, october: 9,
      nov: 10, november: 10,
      dec: 11, december: 11,
    };

    // "15 May 2025" or "May 15 2025"
    if (parts.length >= 3) {
      let day: number, month: number, year: number;
      if (/^\d{1,2}$/.test(parts[0])) {
        day = parseInt(parts[0]);
        month = monthMap[parts[1].toLowerCase()] ?? -1;
        year = parseInt(parts[2]);
      } else {
        month = monthMap[parts[0].toLowerCase()] ?? -1;
        day = parseInt(parts[1]);
        year = parseInt(parts[2]);
      }
      if (month >= 0 && day >= 1 && day <= 31 && year >= 2020 && year <= 2030) {
        const dt = new Date(year, month, day);
        return dt.toISOString().slice(0, 10);
      }
    }
    return null;
  }

  return d.toISOString().slice(0, 10);
}

export function extractJobsFromText(text: string): number | null {
  // "cut 200 jobs", "laid off 200 employees", "reduce workforce by 300"
  const patterns = [
    /(?:cut|laid\s*off|shed|trimmed?|axed?|slashed?|eliminated?)\s+(\d[\d,]*)\s*(?:jobs?|employees?|staff|roles?|positions?|workers?)/i,
    /(?:reduce|cut|trim)\s+(?:its\s+)?(?:workforce|headcount|staff)\s+by\s+(\d[\d,]*)/i,
    /retrench(?:ed|ing)?\s+(\d[\d,]*)\s*(?:jobs?|employees?|staff|roles?|workers?)/i,
    /(\d[\d,]*)\s*(?:jobs?|employees?|staff|roles?|positions?|workers?)\s+(?:cut|axed|slashed|eliminated|affected)/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      return parseInt(m[1].replace(/,/g, ''));
    }
  }

  return null;
}

export function extractPctFromText(text: string): number | null {
  const patterns = [
    /(?:cut|laid\s*off|shed|reduce)\s+(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:its\s+)?(?:workforce|staff|employees|headcount)/i,
    /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:its\s+)?(?:workforce|staff|employees|headcount)\s+(?:cut|axed|laid\s*off)/i,
    /cutting\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      return parseFloat(m[1]);
    }
  }

  return null;
}
