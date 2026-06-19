import { describe, it, expect } from 'vitest';
import {
  buildClusters,
  resolveCluster,
  withinWindow,
  type ClusterNode,
} from '../scripts/cluster';
import { companyTokens } from '../scripts/normalize';

function node(over: Partial<ClusterNode> & { idx: number }): ClusterNode {
  // Distinct URL per node by default: buildClusters unions rows sharing an exact
  // URL, so a shared default would collapse unrelated nodes into one cluster.
  return {
    kind: 'candidate',
    company: 'Grab',
    date_announced: '2026-05-01',
    url: `https://www.example.com/article-${over.idx}`,
    notes: '',
    jobs_cut: null,
    ...over,
  };
}

describe('withinWindow', () => {
  it('is true within the 21-day window and false outside it', () => {
    expect(withinWindow('2026-05-01', '2026-05-20')).toBe(true);
    expect(withinWindow('2026-05-01', '2026-05-25')).toBe(false);
  });

  it('is false when either date is missing or unparseable', () => {
    expect(withinWindow('', '2026-05-01')).toBe(false);
    expect(withinWindow('2026-05-01', 'nope')).toBe(false);
  });
});

describe('buildClusters', () => {
  const tokens = companyTokens(['Grab', 'Shopee']);

  it('groups same-company rows within the window and separates the rest', () => {
    const nodes = [
      node({ idx: 0, company: 'Grab', date_announced: '2026-05-01' }),
      node({ idx: 1, company: 'Grab', date_announced: '2026-05-10' }),
      node({ idx: 2, company: 'Shopee', date_announced: '2026-05-02' }),
      node({ idx: 3, company: 'Grab', date_announced: '2026-08-01' }), // out of window
    ];
    const clusters = buildClusters(nodes, tokens);

    const grabPair = clusters.find(
      (c) => c.members.length === 2 && c.members.every((m) => m.company === 'Grab')
    );
    expect(grabPair).toBeDefined();

    // Shopee and the out-of-window Grab each stand alone.
    expect(clusters.filter((c) => c.members.length === 1)).toHaveLength(2);
  });
});

describe('resolveCluster', () => {
  const tokens = companyTokens(['Grab']);

  it('picks the highest-scoring candidate as canonical', () => {
    const nodes = [
      node({ idx: 0, date_announced: '2026-05-01', jobs_cut: 100 }), // has headcount → higher score
      node({ idx: 1, date_announced: '2026-05-05', jobs_cut: null }),
    ];
    const cluster = buildClusters(nodes, tokens).find((c) => c.members.length === 2)!;
    const res = resolveCluster(cluster);

    expect(res.kind).toBe('canonical');
    if (res.kind === 'canonical') {
      expect(res.canonicalIdx).toBe(0);
      expect(res.rejectedCandidateIdxs).toEqual([1]);
    }
  });

  it('prefers an existing anchor over candidates', () => {
    const nodes = [
      node({ idx: 0, kind: 'anchor', date_announced: '2026-05-03' }),
      node({ idx: 1, kind: 'candidate', date_announced: '2026-05-05', jobs_cut: 500 }),
    ];
    const cluster = buildClusters(nodes, tokens).find((c) => c.members.length === 2)!;
    const res = resolveCluster(cluster);

    expect(res.kind).toBe('anchored');
    if (res.kind === 'anchored') {
      expect(res.anchor.idx).toBe(0);
      expect(res.rejectedCandidateIdxs).toEqual([1]);
    }
  });
});
