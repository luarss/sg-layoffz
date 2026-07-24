// Phase 1+2 of triage: cluster review-queue candidates with existing layoffs.csv
// anchors by (normalized company, ±21 day window), then deduplicate within each
// cluster. Replaces the hardcoded DUPLICATE_COMPANY_HINTS regex list in
// scripts/triage.ts.
//
// Cluster scope: candidates ∪ layoffs.csv anchors only. rejected.csv is excluded
// from fuzzy clustering on purpose — exact URL / fingerprint matches against
// rejected.csv are already covered at scrape-ingestion time by isDuplicate().

import { LayoffEntry } from '../src/lib/types';
import { normalizeCompany, companyTokens, type CompanyTokenMap } from './normalize';
import { extractGnFingerprint } from './deduplicate';

const DAY_MS = 86_400_000;
export const CLUSTER_WINDOW_DAYS = 21;

export type NodeKind = 'candidate' | 'anchor';

export type ClusterNode = {
  idx: number;            // index in the original candidates or anchors array
  kind: NodeKind;
  company: string;        // raw company field (pre-normalize)
  date_announced: string; // YYYY-MM-DD
  url: string;            // canonical_url for candidates, source_link for anchors
  notes: string;          // carries [gn:<fp>] fingerprint when available
  jobs_cut: number | null;
  // Pre-classification signals (candidates only; ignored on anchors):
  eventRuleMatched?: boolean;
  brokenUrl?: boolean;
};

export type Cluster = {
  id: number;
  members: ClusterNode[];
  hasAnchor: boolean;
};

export type Resolution =
  | { kind: 'anchored'; anchor: ClusterNode; rejectedCandidateIdxs: number[] }
  | { kind: 'canonical'; canonicalIdx: number; rejectedCandidateIdxs: number[] }
  | { kind: 'passthrough'; idx: number };

// ---------- company key ----------

const AGGREGATOR_KEY = '__aggregator__';
const UNKNOWN_PREFIX = '__unknown__:';

// Build two search surfaces for a node. The "title surface" weights the row's
// company field (headline) — earliest match here wins because news headlines
// lead with the primary subject. The "full surface" appends the URL path so
// rows with a degenerate title still get matched by URL tokens.
function searchSurfaces(node: ClusterNode): { title: string; full: string } {
  const titleText = (node.company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const title = ' ' + titleText.replace(/\s+/g, ' ').trim() + ' ';
  const lower = (node.url || '').toLowerCase();
  const path = lower.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
  const pathText = path.replace(/[-_/.]+/g, ' ');
  const full = ' ' + (titleText + ' ' + pathText).replace(/\s+/g, ' ').trim() + ' ';
  return { title, full };
}

// Find the earliest variant-match position for a single company in a surface,
// or -1 if no variant matches.
function earliestMatch(variants: string[], surface: string): number {
  let best = -1;
  for (const v of variants) {
    const idx = surface.indexOf(' ' + v + ' ');
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

// Returns the canonical company key for a node. Heuristic:
//   1. Search the title surface (row.company). If any token matches, the
//      company with the earliest position wins — headlines lead with the
//      primary subject. If 3+ distinct companies match the title, it's an
//      aggregator listicle → AGGREGATOR_KEY (won't cluster).
//   2. If nothing matches the title, search the full surface (title + URL path).
//      Same earliest-position-wins rule.
//   3. Fall back to normalized company name (≥3 chars).
//   4. Otherwise a unique unknown key so the node clusters with nothing.
export function companyKeyForNode(node: ClusterNode, tokens: CompanyTokenMap): string {
  const { title, full } = searchSurfaces(node);

  const pickEarliest = (surface: string): string | null => {
    const matches: { key: string; pos: number }[] = [];
    for (const [key, variants] of tokens) {
      const pos = earliestMatch(variants, surface);
      if (pos !== -1) matches.push({ key, pos });
    }
    if (matches.length === 0) return null;
    if (matches.length >= 3) return AGGREGATOR_KEY;
    matches.sort((a, b) => a.pos - b.pos);
    return matches[0].key;
  };

  const fromTitle = pickEarliest(title);
  if (fromTitle) return fromTitle;
  const fromFull = pickEarliest(full);
  if (fromFull) return fromFull;

  const norm = normalizeCompany(node.company || '').toLowerCase().trim();
  if (norm.length >= 3) return norm;
  return UNKNOWN_PREFIX + node.kind + ':' + node.idx;
}

// ---------- date window ----------

function dateMs(s: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function withinWindow(a: string, b: string, days = CLUSTER_WINDOW_DAYS): boolean {
  const da = dateMs(a);
  const db = dateMs(b);
  if (da == null || db == null) return false;
  return Math.abs(da - db) <= days * DAY_MS;
}

// ---------- union-find ----------

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(i: number, j: number): void {
    const ri = this.find(i);
    const rj = this.find(j);
    if (ri !== rj) this.parent[ri] = rj;
  }
}

// ---------- cluster build ----------

export function buildClusters(nodes: ClusterNode[], tokens: CompanyTokenMap): Cluster[] {
  const n = nodes.length;
  const keys = nodes.map((node) => companyKeyForNode(node, tokens));
  const uf = new UnionFind(n);

  for (let i = 0; i < n; i++) {
    if (keys[i] === AGGREGATOR_KEY || keys[i].startsWith(UNKNOWN_PREFIX)) continue;
    for (let j = i + 1; j < n; j++) {
      if (keys[i] !== keys[j]) continue;
      if (!withinWindow(nodes[i].date_announced, nodes[j].date_announced)) continue;
      uf.union(i, j);
    }
  }

  // Also collapse rows that share an exact GN fingerprint or canonical URL,
  // even when the (company, date) check failed (e.g. same article re-fetched
  // under a different wrapper with a date drift > the window).
  const fpIndex = new Map<string, number>();
  const urlIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const fp = extractGnFingerprint(nodes[i].notes || '');
    if (fp) {
      const prev = fpIndex.get(fp);
      if (prev != null) uf.union(prev, i);
      else fpIndex.set(fp, i);
    }
    const u = (nodes[i].url || '').toLowerCase();
    if (u) {
      const prev = urlIndex.get(u);
      if (prev != null) uf.union(prev, i);
      else urlIndex.set(u, i);
    }
  }

  const buckets = new Map<number, ClusterNode[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const arr = buckets.get(root);
    if (arr) arr.push(nodes[i]);
    else buckets.set(root, [nodes[i]]);
  }

  let id = 0;
  const out: Cluster[] = [];
  for (const members of buckets.values()) {
    out.push({
      id: id++,
      members,
      hasAnchor: members.some((m) => m.kind === 'anchor'),
    });
  }
  return out;
}

// ---------- within-cluster dedup ----------

// Score a candidate node for canonical selection. Higher is better.
function canonicalScore(node: ClusterNode): number {
  let s = 0;
  if (node.eventRuleMatched) s += 1000;
  if (node.jobs_cut != null) s += 100;
  const host = (node.url || '').match(/^https?:\/\/([^/]+)/)?.[1] || '';
  if (host && !host.includes('news.google.com')) s += 50;
  if (!node.brokenUrl) s += 10;
  return s;
}

export function resolveCluster(cluster: Cluster): Resolution {
  if (cluster.hasAnchor) {
    const anchor = cluster.members.find((m) => m.kind === 'anchor')!;
    const rejected = cluster.members.filter((m) => m.kind === 'candidate').map((m) => m.idx);
    return { kind: 'anchored', anchor, rejectedCandidateIdxs: rejected };
  }

  const candidates = cluster.members.filter((m) => m.kind === 'candidate');
  if (candidates.length === 1) {
    return { kind: 'passthrough', idx: candidates[0].idx };
  }

  // Sort: highest score, then earliest date, then lowest idx (stable).
  const ranked = [...candidates].sort((a, b) => {
    const sd = canonicalScore(b) - canonicalScore(a);
    if (sd !== 0) return sd;
    const da = dateMs(a.date_announced) ?? Number.MAX_SAFE_INTEGER;
    const db = dateMs(b.date_announced) ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.idx - b.idx;
  });

  const canonical = ranked[0];
  const rejected = ranked.slice(1).map((m) => m.idx);
  return { kind: 'canonical', canonicalIdx: canonical.idx, rejectedCandidateIdxs: rejected };
}

// ---------- convenience: build nodes from triage-shaped inputs ----------

export function anchorsFromLayoffs(rows: LayoffEntry[]): ClusterNode[] {
  return rows.map((r, idx) => ({
    idx,
    kind: 'anchor' as const,
    company: r.company || '',
    date_announced: r.date_announced || '',
    url: r.source_link || '',
    notes: r.notes || '',
    jobs_cut: r.jobs_cut_sg != null ? Number(r.jobs_cut_sg) : r.jobs_cut_global != null ? Number(r.jobs_cut_global) : null,
  }));
}

export function buildCompanyTokens(layoffs: LayoffEntry[]): CompanyTokenMap {
  return companyTokens(layoffs.map((r) => r.company).filter(Boolean));
}
