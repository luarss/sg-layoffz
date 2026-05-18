// Triage resolved review-queue entries into confirmed / rumored / rejected.
// Reads data/review-queue-resolved.json (produced by scripts/resolve-gnews.ts),
// applies a rules-driven classification, and writes:
//   - data/layoffs.csv : appended with new confirmed / rumored entries
//   - data/rejected.csv : appended with all rejected entries
//   - data/review-queue.csv : cleared (header only)

import fs from 'node:fs';
import Papa from 'papaparse';
import { readCsv } from '../src/lib/csv';
import { LayoffEntry, CSV_HEADERS, INDUSTRIES } from '../src/lib/types';
import { normalizeCompany } from './normalize';
import {
  buildClusters,
  resolveCluster,
  anchorsFromLayoffs,
  buildCompanyTokens,
  type ClusterNode,
} from './cluster';

type ResolvedRow = {
  company: string;
  date_announced: string;
  jobs_cut: number | null;
  pct_workforce: number | null;
  industry: string;
  source_link: string;
  notes: string;
  status: string;
  canonical_url: string;
};

type Verdict = 'confirmed' | 'rumored' | 'rejected' | 'queue';

// Manual override map: keyed by row index in the resolved JSON file (0-based).
// Use this when a row needs a verdict, a curated company name, a different
// industry, or extra notes that can't be derived automatically.
type Override = Partial<{
  verdict: Verdict;
  company: string;
  industry: string;
  jobs_cut: number;
  pct_workforce: number;
  notes: string;
  date_announced: string;
}>;

// Load canonical entries from layoffs.csv — used both as clustering anchors
// and as a final cross-cluster (company, YYYY-MM) sanity check when an event
// rule canonicalizes a row to a different company than its raw row.company.
function loadExistingLayoffs(): LayoffEntry[] {
  return readCsv('layoffs.csv') as LayoffEntry[];
}

function monthKey(name: string, date: string): string {
  return `${normalizeCompany(name).toLowerCase()}|${date.slice(0, 7)}`;
}

// Patterns indicating commentary / statistics / policy debate -> reject
const REJECT_KEYWORDS = [
  'advance notif', 'advance notice', 'mandatory advance', 'mandating advance',
  'jobseeker support', 'career bridges', 'career bridge', 'esr proposes',
  'esr committee', 'budget 2026', 'ntuc calls', 'ntuc chief', 'ntuc to call',
  'patrick tay', 'pritam singh', 'psp rejects', 'snef backs', 'snef ',
  'mom data', 'mom to review', 'manpower minister', 'tan see leng',
  'mandatory early', 'late ', 'penalties for late',
  'pmet ', 'retrenchments rise', 'retrenchments rose', 'retrenchments stable',
  'mti data', 'labour market', 'employment growth', 'employment up by',
  'hiring momentum', 'hiring boom', 'hiring remains', 'tech salaries',
  'jobs portal', 'job market', 'job hugging', 'job hunt',
  'commentary:', 'explainer:', 'st explains', 'deep dive podcast',
  'mps raise', 'mp raises', 'parliament supports',
  'ai is taking the blame', 'ai is displacing', 'ai job', 'ai-upskilling',
  'ai-exposed', 'ai recruitment', 'ai growth through', 'ai disruption',
  'employer-friendly', 'pro-business', 'balanced approach',
  'foreign workers take', "singaporean", "singaporeans say", 'singaporeans have',
  'inside ntuc', 'inside twitter', // commentary/feature
  'navigating', 'embrace ai', 'no jobless growth', 'good jobs',
  'i got laid off', 'laid off by email', 'laid-off tech', 'i applied to over',
  '‘i ', "'i am tired", 'i am tired', 'i had 10 months', "‘how i", 'how i coped',
  "‘our sg head", 'our sg head', 'employee rattled', 'employee worn down',
  "‘one meeting", 'one meeting away',
  'no corporate loyalty', 'no new layoffs', '‘no new layoffs',
  'stop hiring humans', 'stop hiring', 'biggest fear', 'bloodied onslaughts',
  'are you going to get', 'great resignation', 'mass layoffs amid',
  'goodbye to big tech', 'culled workers', 'zero empathy',
  'job, vacancies', 'pmet layoffs, vacancies',
  'reviewing 2025', 'high-profile tech layoffs', 'tech firms slash',
  'amazon bungles', // about email gaffe, not a new event
  'singapore not spared', // older Amazon round, already represented
  'singapore can’t afford', 'singapore can’t', "singapore can't",
  'behind job losses', 'job losses are real people',
  'meta and microsoft have joined', // commentary
  'meta layoffs: the ripple effects', 'meta layoffs amid ai spending',
  'meta planning sweeping', // duplicate of meta confirmed
  'meta allegedly laying off', 'meta prepares fresh wave',
  'meta to begin first wave', 'meta ceo zuckerberg',
  '23k roles at risk', 'meta, microsoft plan',
  'singapore market weekly', 'wall street banks',
  'global firms ramp up', 'global pressures', 'global giants',
  'global public relations', 'global pr firm', // duplicates of we.communications
  'forms of government', 'inside ntuc',
  'tech sector job', 'tech and finance sectors', 'tech talent hunt',
  'tech’s been hit', "tech's been hit", 'tech layoffs:',
  'top ikea retailer', // global, no SG mention
  'singapore court rejects', // legal case
  'retrenched man loses', // legal case
  'retrenchment in singapore: what employers', // HR advice
  '19 years of service', // anecdote
  'singapore says ai must', 'singapore ramps up ai',
  'singapore approves plan', 'singapore urges',
  'singapore invokes', 'singapore sees more', 'singapore court',
  'singapore will not raise', 'no plans to raise', 'no need to raise',
  's’pore added', "s'pore added", 's’pore sets out', "s'pore sets out",
  's’poreans', "s'poreans",
  'singapore firms feel', 'singapore can', 'singapore approves',
  'singapore tech employee says', 'singapore tech salaries',
  'singapore unions offering', 'singapore not spared',
  'singapore’s digital economy', "singapore's digital economy",
  'singapore’s finance sector', "singapore's finance sector",
  'singapore’s gxs', "singapore's gxs", // duplicate of GXS
  'singapore’s three major banks', "singapore's three major banks",
  'singapore’s new ai', "singapore's new ai",
  'singapore’s total employment', "singapore's total employment",
  'singapore can’t afford', "singapore can't afford",
  'singapore labour market', 'singapore hiring momentum',
  'unions call for advance', 'why are tech companies',
  'why are there so many', 'what could block',
  'are piling up', 'are warming up',
  'finance sector ranks', 'information, communications tops',
  'retail sector amongst', 'malaysian', // too vague
  'high-skilled workers', 'your degree means nothing',
  'job-hunting', 'jobseeker', 'job-hugging',
  'massive job', 'uk job', // global commentary
  'fuku ai', 'xoogler', // support/community
  'online community',
  'cisco stock jumps', // markets commentary
  'i applied to', 'i had 10', 'i got laid', // personal
  'great resignation to great', 'southeast asia’s tech',
  "southeast asia's tech",
  'sg market weekly',
  'us-based company announced', // too vague
  'about 9 in 10', 'about 90% of', 'about 9 in', 'more s’poreans',
  "more s'poreans", 'more can be done',
  'foreign workers take', 'unions call', 'union call',
  'crypto industry twice', // crypto.com duplicate
  'crypto exchange gemini plans', // covered as rumored if explicit
  'singapore banks', // statistics
  'singapore layoffs in 2025', 'singapore layoffs 2026: from tiger',
  'reviewing 2025 in singapore',
  '1,270 layoffs reported',
  'layoffs are piling up', 'layoffs in singapore rise',
  'mom data shows', 'mas data',
  '43% singapore professionals',
  'singapore becomes primary hub', // about Gemini AI, not layoffs
  'sia cuts staff bonus', // bonus cut, not layoff
  'cuts staff bonus', // bonus cut
  'kpmg uk could', // UK-specific
  '“don’t abandon workers”', "\"don't abandon workers\"", // PM speech
  'don’t abandon workers', "don't abandon workers",
  "kenneth tiong calls", 'leong mun wai renews',
  'us jobless claims', 'us-jobless-claims',
  'are we all one meeting away', // anecdote/commentary
  'indonesia’s goto', "indonesia's goto", // Indonesia-focused
  'severance policy for india', // commentary on Oracle India
  'severance clauses', // commentary on Agoda severance
  'just got retrenched', // guide
  'retrenchment in the spotlight', // HR lessons commentary
  'layoffs and job cuts singapore 2024', // year-in-review summary
  'tech sackings', // commentary
  'tech sector companies retrench', // commentary
  'layoffs on everyone', // anxiety/commentary
  'fear fallout',
  'ripple effects on employees', // commentary
  'jobs first approach', 'jobs-first approach',
  'dbs, ocbc & uob', 'dbs ocbc uob', 'dbs-ocbc-uob', // SG bank aggregator commentary
  'ntuc employers split', 'retrenchment notice lead time',
  'ntuc offers support', 'ntuc aims to step up',
  'how singapore tech layoffs are impacting indians', // impact commentary
  'retrenchment hits the most expensive', // anecdote
  'why retrenchment benefits aren', // commentary
  'regional offices across asia could see bulk', // opinion
  'jobs workers ai artificial intelligence reshape', // commentary
  'retrenchment tech layoffs no jobs search long', // commentary
  'retrenchment benefit not mandatory', // policy
  'nestl begins south africa', 'nestle begins south africa', // dup of Nestlé entry
  'crypto com lays 12 staff', 'singapore based crypto com lays', // dup of Crypto.com entry
  'biospace layoff tracker', 'biospace.com', // generic aggregator
  'danske bank', // Nordic bank, no SG nexus
];

// Patterns indicating it's about a specific company event we want to keep.
// Maps a normalized keyword in lowercase title to a company canonical name,
// the canonical industry, and the verdict.
type EventRule = {
  match: RegExp;
  company: string;
  industry: string;
  verdict: Verdict;
  notes?: string;
};
const EVENT_RULES: EventRule[] = [
  // ----- Confirmed Singapore-specific events -----
  { match: /biontech to close|biontech.*singapore affecting/i, company: 'BioNTech Singapore', industry: 'Other', verdict: 'confirmed', notes: 'BioNTech closing Germany + Singapore sites, ~1,860 staff affected globally' },
  { match: /temasek-backed partior|partior slashes/i, company: 'Partior', industry: 'Tech', verdict: 'confirmed', notes: 'Temasek-backed fintech cuts ~30% of Singaporean team after US$60M funding round' },
  { match: /microsoft to lay off 9000|microsoft cuts hundreds more|second wave of job/i, company: 'Microsoft', industry: 'Tech', verdict: 'confirmed', notes: 'Microsoft 2025 follow-up rounds (June hundreds; July 9,000) after May 6,000 cuts; incl. Singapore' },
  { match: /tiger beer|apb singapore|apbs/i, company: 'APBs (Tiger Beer)', industry: 'Manufacturing', verdict: 'confirmed', notes: 'Scaling down Tuas brewing operations; ~130 SG roles cut over 2 years' },
  { match: /dhl unit in singapore|dhl unit confirms/i, company: 'DHL Singapore', industry: 'Other', verdict: 'confirmed', notes: 'DHL Singapore confirms retrenchment of workers; scope undisclosed' },
  { match: /dhl unit$/i, company: 'DHL Singapore', industry: 'Other', verdict: 'confirmed', notes: 'DHL Singapore confirms retrenchment of workers; scope undisclosed' },
  { match: /exxonmobil|exxon/i, company: 'ExxonMobil Singapore', industry: 'Other', verdict: 'confirmed', notes: 'ExxonMobil expects to cut ~500 SG staff (10–15%) by end-2027' },
  { match: /jobs portal indeed|indeed shuts singapore|indeed laid off in singapore/i, company: 'Indeed', industry: 'Tech', verdict: 'confirmed', notes: 'Shut Singapore tech office, ~120 staff affected' },
  { match: /sph media/i, company: 'SPH Media', industry: 'Other', verdict: 'confirmed', notes: 'Layoffs across SPH Media SG operations' },
  { match: /moneyhero/i, company: 'MoneyHero', industry: 'Finance', verdict: 'confirmed', notes: 'Singapore fintech MoneyHero laid off 80 staff to cut costs' },
  { match: /google singapore hit by|google axes employees/i, company: 'Google', industry: 'Tech', verdict: 'confirmed' },
  { match: /tech giant google/i, company: 'Google', industry: 'Tech', verdict: 'confirmed', notes: 'Global Google layoffs incl. Singapore' },
  { match: /microsoft cutting|microsoft layoffs hit software engineers|microsoft announces global job/i, company: 'Microsoft', industry: 'Tech', verdict: 'confirmed', notes: 'Global Microsoft layoffs incl. Singapore' },
  { match: /tiktok cuts trust and safety|tiktok layoffs: job|tiktok,/i, company: 'TikTok', industry: 'Tech', verdict: 'confirmed' },
  { match: /^tiktok$/i, company: 'TikTok', industry: 'Tech', verdict: 'confirmed' },
  { match: /singapore unions offering support to.*tiktok/i, company: 'TikTok', industry: 'Tech', verdict: 'confirmed', notes: 'TikTok SG layoffs; NTUC support offered' },
  { match: /sea e-commerce arm shopee/i, company: 'Shopee', industry: 'Tech', verdict: 'confirmed', notes: 'Sea/Shopee layoffs in Singapore' },
  { match: /more layoffs at shopee/i, company: 'Shopee', industry: 'Tech', verdict: 'confirmed', notes: 'Additional Shopee layoffs in Singapore' },
  { match: /twitter.+layoffs in singapore|inside twitter/i, company: 'Twitter', industry: 'Tech', verdict: 'confirmed', notes: 'Twitter Singapore layoffs post-Musk takeover' },
  { match: /meta layoffs: singapore employees affected/i, company: 'Meta', industry: 'Tech', verdict: 'confirmed', notes: '2022 Meta SG layoffs' },
  { match: /meta layoffs hit singapore.*2022|^meta$/i, company: 'Meta', industry: 'Tech', verdict: 'confirmed', notes: '2022 Meta SG layoffs' },
  { match: /meta layoffs hit singapore/i, company: 'Meta', industry: 'Tech', verdict: 'confirmed' },
  { match: /creative technology/i, company: 'Creative Technology', industry: 'Tech', verdict: 'confirmed', notes: 'Singapore audio tech company restructuring' },
  { match: /standard chartered/i, company: 'Standard Chartered', industry: 'Finance', verdict: 'confirmed', notes: 'Standard Chartered Singapore layoffs reported' },
  { match: /we\. communications/i, company: 'We. Communications', industry: 'Other', verdict: 'confirmed', notes: 'Global PR firm closed/scaled down Singapore office' },
  { match: /manus capital/i, company: 'Manus Capital', industry: 'Finance', verdict: 'confirmed', notes: 'Post-HQ relocation to Singapore, restructuring/layoffs' },
  { match: /cj logistics asia/i, company: 'CJ Logistics Asia', industry: 'Other', verdict: 'confirmed', notes: 'Logistics arm retrenchment' },
  { match: /crypto\.com announces layoffs of 12%/i, company: 'Crypto.com', industry: 'Finance', verdict: 'confirmed', notes: '12% of staff cut in 2026 round' },
  { match: /crypto\.com,.*based in s'pore|crypto\.com.*based in s’pore/i, company: 'Crypto.com', industry: 'Finance', verdict: 'confirmed', notes: '2026 layoff round, ~12% of staff' },
  { match: /goldman .* join layoffs/i, company: 'Goldman Sachs', industry: 'Finance', verdict: 'confirmed', notes: 'Goldman layoffs incl. Singapore' },

  // ----- Rumored / planned global rounds with SG exposure -----
  { match: /hsbc.*(weighs|mulls)/i, company: 'HSBC', industry: 'Finance', verdict: 'rumored', notes: 'HSBC weighing deep cuts globally; Singapore office potentially affected' },
  { match: /societe generale|soci.* g.*n.*rale/i, company: 'Société Générale', industry: 'Finance', verdict: 'rumored', notes: 'Plans ~1,800 job cuts globally' },
  { match: /atlassian/i, company: 'Atlassian', industry: 'Tech', verdict: 'rumored', notes: '~1,600 job cuts planned globally; SG office potentially affected' },
  { match: /citi moves ahead with/i, company: 'Citi', industry: 'Finance', verdict: 'rumored', notes: 'Citi ~1,000 job cuts moving ahead' },
  { match: /jack dorsey|block ceo/i, company: 'Block', industry: 'Finance', verdict: 'rumored', notes: 'Block (Jack Dorsey) ~4,000 job cuts globally' },
  { match: /wisetech/i, company: 'WiseTech', industry: 'Tech', verdict: 'rumored', notes: 'Plans ~2,000 job cuts globally' },
  { match: /nestl[eé]’s plans|nestl[eé]'s plans/i, company: 'Nestlé', industry: 'Other', verdict: 'rumored', notes: 'Plans ~16,000 job cuts globally' },
  { match: /snapchat parent/i, company: 'Snap (Snapchat)', industry: 'Tech', verdict: 'rumored', notes: 'Snap layoffs reported' },
  { match: /disney is/i, company: 'Disney', industry: 'Other', verdict: 'rumored', notes: 'Disney layoffs reported' },
  { match: /^nokia /i, company: 'Nokia', industry: 'Tech', verdict: 'rumored', notes: 'Nokia preparing for layoffs incl. India/APAC' },
  { match: /^basf /i, company: 'BASF', industry: 'Manufacturing', verdict: 'rumored', notes: 'BASF announces job cuts' },
  { match: /^blackrock/i, company: 'BlackRock', industry: 'Finance', verdict: 'rumored', notes: 'BlackRock layoffs reported' },
  { match: /ubs plans january/i, company: 'UBS', industry: 'Finance', verdict: 'rumored', notes: 'Plans January 2026 job cuts' },
  { match: /^apple\b/i, company: 'Apple', industry: 'Tech', verdict: 'rumored', notes: 'Apple layoffs reported' },
  { match: /^hp to\b/i, company: 'HP', industry: 'Tech', verdict: 'rumored', notes: 'HP planning further job cuts' },
  { match: /paypal plans/i, company: 'PayPal', industry: 'Finance', verdict: 'rumored', notes: 'PayPal plans job cuts' },
  { match: /^cloudflare/i, company: 'Cloudflare', industry: 'Tech', verdict: 'rumored', notes: 'Cloudflare layoffs reported' },
  { match: /^how many employees work at ibm/i, company: 'IBM', industry: 'Tech', verdict: 'rumored', notes: 'IBM layoffs reported' },
  { match: /sony pictures entertainment/i, company: 'Sony Pictures Entertainment', industry: 'Other', verdict: 'rumored', notes: 'Sony Pictures layoffs reported' },
  { match: /^pinterest/i, company: 'Pinterest', industry: 'Tech', verdict: 'rumored', notes: 'Pinterest layoffs reported' },
  { match: /crypto exchange gemini plans/i, company: 'Gemini', industry: 'Finance', verdict: 'rumored', notes: 'Gemini plans to cut staff' },
  { match: /heineken to/i, company: 'Heineken', industry: 'Manufacturing', verdict: 'rumored', notes: 'Heineken job cuts globally (parent of APBs)' },
  { match: /oracle plans thousands/i, company: 'Oracle', industry: 'Tech', verdict: 'rumored', notes: 'Oracle plans thousands more job cuts' },
  { match: /struggling nike will|^nike will/i, company: 'Nike', industry: 'Other', verdict: 'rumored', notes: 'Plans ~1,400 job cuts globally amid turnaround' },
  { match: /^morgan stanley\b/i, company: 'Morgan Stanley', industry: 'Finance', verdict: 'rumored', notes: 'Morgan Stanley lays off ~2,500 globally; SG office potentially affected' },
  { match: /porsche shutters three units/i, company: 'Porsche', industry: 'Manufacturing', verdict: 'rumored', notes: 'Porsche shutters three units in first job cuts under new CEO' },
  { match: /anz latest to/i, company: 'ANZ', industry: 'Finance', verdict: 'rumored', notes: 'ANZ joins 2025 wave of bank/tech layoffs' },
  { match: /traveloka layoffs/i, company: 'Traveloka', industry: 'Tech', verdict: 'rumored', notes: 'Traveloka reorganising workforce around capabilities, tech and growth; SG office potentially affected' },

  // ----- Duplicates of confirmed events already in layoffs.csv -----
];

// Manual per-row overrides keyed by 0-based index in the resolved JSON.
// Index-keyed overrides are inherently single-run; prefer adding patterns to
// EVENT_RULES or REJECT_KEYWORDS so the rule survives across scrapes. Use
// this map only for one-off cases that can't be captured as a reusable
// pattern. Per-company dedup is no longer pattern-driven — see scripts/cluster.ts.
const OVERRIDES: Record<number, Override> = {};

// Build a matchable text blob from the row's title and canonical URL path.
// Many gnews-derived titles are truncated to a single word ("Microsoft", "Why",
// "Sia"), so the URL path is often the most discriminating signal.
function matchText(row: ResolvedRow): string {
  const path = (row.canonical_url || '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/[-_/.]/g, ' ');
  return `${row.company || ''} ${path}`;
}

function isPolicyOrCommentary(text: string): boolean {
  const t = text.toLowerCase();
  return REJECT_KEYWORDS.some((k) => t.includes(k.toLowerCase()));
}

function matchEvent(text: string): EventRule | null {
  for (const rule of EVENT_RULES) {
    if (rule.match.test(text)) return rule;
  }
  return null;
}

type PreClassification = {
  verdict: Verdict;
  override: Override;
  reason: string;
  eventRuleMatched: boolean;
  // Set when the row matched OVERRIDES[idx].verdict — manual overrides win
  // even over cluster-anchor rejection.
  manualOverride: boolean;
};

// Pre-classify a single row without any duplicate detection. Clustering runs
// after this pass and may override the verdict to 'rejected' (anchored cluster
// or intra-batch duplicate).
function preClassify(row: ResolvedRow, idx: number): PreClassification {
  const override = OVERRIDES[idx] || {};
  const text = matchText(row);

  if (override.verdict) {
    return {
      verdict: override.verdict,
      override,
      reason: 'manual override',
      eventRuleMatched: false,
      manualOverride: true,
    };
  }

  const eventRule = matchEvent(text);
  if (eventRule) {
    return {
      verdict: eventRule.verdict,
      override: {
        company: eventRule.company,
        industry: eventRule.industry,
        notes: eventRule.notes,
      } as Override,
      reason: `Event rule: ${eventRule.match}`,
      eventRuleMatched: true,
      manualOverride: false,
    };
  }

  if (isPolicyOrCommentary(text)) {
    return {
      verdict: 'rejected',
      override: {},
      reason: 'Commentary / statistics / policy — not a specific layoff event',
      eventRuleMatched: false,
      manualOverride: false,
    };
  }

  return {
    verdict: 'queue',
    override: {},
    reason: 'Unclassified — kept in review queue for manual triage',
    eventRuleMatched: false,
    manualOverride: false,
  };
}

function toLayoffEntry(row: ResolvedRow, verdict: Verdict, override: Override): LayoffEntry {
  const industry = (override.industry as string) || row.industry || 'Other';
  const finalIndustry = (INDUSTRIES as readonly string[]).includes(industry) ? industry : 'Other';
  return {
    company: override.company ?? row.company,
    date_announced: override.date_announced ?? row.date_announced,
    jobs_cut: override.jobs_cut ?? (row.jobs_cut == null ? null : Number(row.jobs_cut)),
    pct_workforce: override.pct_workforce ?? (row.pct_workforce == null ? null : Number(row.pct_workforce)),
    industry: finalIndustry,
    source_link: row.canonical_url || row.source_link,
    notes: override.notes ?? row.notes ?? '',
    status:
      verdict === 'rejected' || verdict === 'queue'
        ? ((row.status as LayoffEntry['status']) || 'rumored')
        : (verdict as LayoffEntry['status']),
  };
}

function appendRows(filename: string, rows: LayoffEntry[]): void {
  if (rows.length === 0) return;
  const path = `${process.cwd()}/data/${filename}`;
  const fileExists = fs.existsSync(path) && fs.readFileSync(path, 'utf-8').trim().length > 0;
  const csv = Papa.unparse(
    rows.map((e) => CSV_HEADERS.map((h) => (e as any)[h] ?? '')),
    { newline: '\n' }
  );
  if (fileExists) {
    fs.appendFileSync(path, csv + '\n');
  } else {
    fs.writeFileSync(path, (CSV_HEADERS as string[]).join(',') + '\n' + csv + '\n');
  }
}

function writeQueue(rows: ResolvedRow[]): void {
  const path = `${process.cwd()}/data/review-queue.csv`;
  // Write only the standard CSV columns (drop canonical_url helper field).
  if (rows.length === 0) {
    fs.writeFileSync(path, (CSV_HEADERS as string[]).join(',') + '\n');
    return;
  }
  const csv = Papa.unparse(
    rows.map((r) => CSV_HEADERS.map((h) => (r as any)[h] ?? '')),
    { newline: '\n' }
  );
  fs.writeFileSync(path, (CSV_HEADERS as string[]).join(',') + '\n' + csv + '\n');
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const resolvedPath = `${process.cwd()}/data/review-queue-resolved.json`;
  if (!fs.existsSync(resolvedPath)) {
    console.error('Missing data/review-queue-resolved.json. Run scripts/resolve-gnews.ts first.');
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as ResolvedRow[];

  // -------- PASS 1: pre-classify (no dedup) --------
  const preClass = rows.map((r, i) => preClassify(r, i));

  // -------- PASS 2: cluster + dedup --------
  const existingLayoffs = loadExistingLayoffs();
  const tokens = buildCompanyTokens(existingLayoffs);

  const candidateNodes: ClusterNode[] = rows.map((r, idx) => ({
    idx,
    kind: 'candidate',
    company: r.company || '',
    date_announced: r.date_announced || '',
    url: r.canonical_url || r.source_link || '',
    notes: r.notes || '',
    jobs_cut: r.jobs_cut == null ? null : Number(r.jobs_cut),
    eventRuleMatched: preClass[idx].eventRuleMatched,
    brokenUrl: /BROKEN URL/i.test(r.notes || ''),
  }));
  const anchorNodes = anchorsFromLayoffs(existingLayoffs);
  const nodes = [...candidateNodes, ...anchorNodes];

  const clusters = buildClusters(nodes, tokens);

  // Final verdicts per candidate idx — start with the pre-classification.
  const finalVerdict: Verdict[] = preClass.map((p) => p.verdict);
  const finalReason: string[] = preClass.map((p) => p.reason);
  const finalOverride: Override[] = preClass.map((p) => p.override);

  for (const cluster of clusters) {
    const resolution = resolveCluster(cluster);
    if (resolution.kind === 'anchored') {
      const anchor = resolution.anchor;
      const anchorLabel = `${anchor.company} (${anchor.date_announced})`;
      for (const idx of resolution.rejectedCandidateIdxs) {
        if (preClass[idx].manualOverride) continue; // manual override always wins
        finalVerdict[idx] = 'rejected';
        finalReason[idx] = `Duplicate of existing ${anchorLabel}`;
        finalOverride[idx] = {};
      }
    } else if (resolution.kind === 'canonical') {
      const canonicalIdx = resolution.canonicalIdx;
      for (const idx of resolution.rejectedCandidateIdxs) {
        if (preClass[idx].manualOverride) continue;
        // Don't downgrade an already-rejected (e.g. commentary) row.
        if (finalVerdict[idx] === 'rejected') continue;
        finalVerdict[idx] = 'rejected';
        finalReason[idx] = `Intra-batch duplicate of row ${canonicalIdx}`;
        finalOverride[idx] = {};
      }
    }
    // passthrough: no change to pre-class verdict
  }

  // -------- PASS 3: cross-cluster (event-rule canonical company, YYYY-MM) safety net --------
  // If two rows match different EVENT_RULES but resolve to the same canonical
  // company + month (e.g. via different clusters because companyKey or date
  // window didn't align), keep only the first.
  const seenMonthKey = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (finalVerdict[i] !== 'confirmed' && finalVerdict[i] !== 'rumored') continue;
    const company = finalOverride[i].company || rows[i].company;
    const date = finalOverride[i].date_announced || rows[i].date_announced || '';
    if (!company || !date) continue;
    const key = monthKey(company, date);
    if (seenMonthKey.has(key)) {
      finalVerdict[i] = 'rejected';
      finalReason[i] = `Duplicate (same canonical ${company}, ${date.slice(0, 7)}) already added this run`;
      finalOverride[i] = {};
    } else {
      seenMonthKey.add(key);
    }
  }

  // -------- Emit results --------
  const confirmed: LayoffEntry[] = [];
  const rumored: LayoffEntry[] = [];
  const rejected: LayoffEntry[] = [];
  const queued: ResolvedRow[] = [];
  const summary: { idx: number; verdict: Verdict; company: string; reason: string }[] = [];

  rows.forEach((row, idx) => {
    const verdict = finalVerdict[idx];
    const override = finalOverride[idx];
    const reason = finalReason[idx];
    if (verdict === 'queue') {
      queued.push(row);
      summary.push({ idx, verdict, company: override.company || row.company, reason });
      return;
    }
    const entry = toLayoffEntry(row, verdict, override);
    if (verdict === 'confirmed') confirmed.push(entry);
    else if (verdict === 'rumored') rumored.push(entry);
    else {
      const notes = (entry.notes && entry.notes.length > 0) ? entry.notes : reason;
      rejected.push({ ...entry, notes });
    }
    summary.push({ idx, verdict, company: override.company || row.company, reason });
  });

  if (dryRun) {
    fs.writeFileSync(
      `${process.cwd()}/data/triage-dryrun.json`,
      JSON.stringify(summary, null, 2)
    );
    console.log('[dry-run] Wrote data/triage-dryrun.json — no CSV mutations.');
  } else {
    appendRows('layoffs.csv', [...confirmed, ...rumored]);
    appendRows('rejected.csv', rejected);
    writeQueue(queued);
    fs.writeFileSync(
      `${process.cwd()}/data/triage-summary.json`,
      JSON.stringify(summary, null, 2)
    );
    console.log('Wrote data/triage-summary.json');
  }

  console.log(`\nTriage summary${dryRun ? ' (dry-run)' : ''}:`);
  console.log(`  confirmed: ${confirmed.length}`);
  console.log(`  rumored:   ${rumored.length}`);
  console.log(`  rejected:  ${rejected.length}`);
  console.log(`  kept in queue: ${queued.length}`);
  console.log(`  total:     ${rows.length}`);

  console.log('\nNew confirmed entries:');
  for (const e of confirmed) {
    console.log(`  - ${e.company} (${e.date_announced}) → ${e.source_link}`);
  }
  console.log('\nNew rumored entries:');
  for (const e of rumored) {
    console.log(`  - ${e.company} (${e.date_announced}) → ${e.source_link}`);
  }
}

main();
