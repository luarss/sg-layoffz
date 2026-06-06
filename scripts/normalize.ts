import { INDUSTRIES } from '../src/lib/types';

const COMPANY_ALIASES: Record<string, string> = {
  'dbs bank': 'DBS',
  'dbs group holdings': 'DBS',
  'dbs group': 'DBS',
  'grab holdings': 'Grab',
  'grab singapore': 'Grab',
  'sea limited': 'Sea',
  'sea group': 'Sea',
  'shopee singapore': 'Shopee',
  'ninja van': 'Ninja Van',
  'gxs bank': 'GXS Bank',
  'mediacorp pte ltd': 'Mediacorp',
  'mediacorp singapore': 'Mediacorp',
  'singtel': 'Singtel',
  'singapore telecommunications': 'Singtel',
  'citigroup': 'Citi',
  'citibank': 'Citi',
};

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

export function normalizeCompany(raw: string): string {
  let name = raw.trim();

  // Check known aliases first
  const lower = name.toLowerCase();
  if (COMPANY_ALIASES[lower]) return COMPANY_ALIASES[lower];

  // Strip suffixes
  for (const suffix of SUFFIXES) {
    const re = new RegExp(`\\s+${suffix.replace(/\./g, '\\.')}$`, 'i');
    name = name.replace(re, '');
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
    'the', 'and', 'group', 'asia', 'singapore', 'pacific', 'global', 'inc',
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
