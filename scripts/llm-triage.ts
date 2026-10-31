// LLM-powered triage for review-queue.csv entries.
// Reads data/review-queue.csv, classifies each entry using an LLM with automatic
// provider fallback (NVIDIA → Z.AI → DeepSeek → MiMo → OpenRouter), and routes results to:
//   - data/layoffs.csv      (confirmed + rumored)
//   - data/rejected.csv     (rejected)
//   - data/review-queue.csv (needs_review — kept for manual triage)
// Writes data/llm-triage-summary.json with full run stats.
//
// Provider fallback order: NVIDIA NIM → Z.AI → DeepSeek → MiMo (Xiaomi) → OpenRouter
// Providers are included automatically when their keys are present.
// A provider is skipped (and the next tried) when it returns an API error.
// The provider chain wiring lives in ./llm-provider (shared with rumor-recheck).

import fs from 'node:fs';
import { readCsv, appendCsv, writeCsv } from '../src/lib/csv';
import { LayoffEntry } from '../src/lib/types';
import { companyKey, eventIdFor } from './normalize';
import { todayIso } from '../src/lib/dates';
import { ProviderConfig, getProviderChain, callJsonWithChain, describeChain } from './llm-provider';
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  formatEventHints,
  hintedEventIds,
  parseModelVerdict,
  withEntryDefaults,
  type EventHint,
  type EventHints,
  type ModelVerdict,
} from './llm-prompt';
import {
  buildClusters,
  resolveCluster,
  anchorsFromLayoffs,
  buildCompanyTokens,
  type Cluster,
  type ClusterNode,
} from './cluster';
import { screenTriageBatch, datasetAnalyzer, type TriageCandidate } from './triage-guard';

interface SummaryRow {
  original_company: string;
  llm_company: string;
  source_link: string;
  verdict: string;
  confidence: string;
  provider: string;
  notes: string;
  rejection_reason?: string;
}

// Existing events per normalized company — lets the model reuse an event_id when the
// queue row is follow-up coverage of an already-tracked event.
function buildEventIndex(layoffs: LayoffEntry[]): Map<string, EventHint[]> {
  const byCompany = new Map<string, Map<string, EventHint>>();
  for (const e of layoffs) {
    if (!e.event_id) continue;
    const key = companyKey(e.company || '');
    if (!byCompany.has(key)) byCompany.set(key, new Map());
    const seen = byCompany.get(key)!;
    if (!seen.has(e.event_id)) {
      seen.set(e.event_id, { event_id: e.event_id, date_announced: e.date_announced, company: e.company });
    }
  }
  const out = new Map<string, EventHint[]>();
  for (const [k, m] of byCompany) out.set(k, [...m.values()]);
  return out;
}

// Per-candidate clustering hints: a "primary" hint (this row clusters with one
// specific existing event — anchor company-token match within ±21 days, or an exact
// URL/fingerprint match) and a "fallback" list of other plausible existing events for
// the same company, surfaced when there's no confident single match.
type ClusterHint = { primary: EventHint | null; fallback: EventHint[] };
const NO_CLUSTER_HINT: ClusterHint = { primary: null, fallback: [] };

// Cluster review-queue candidates against layoffs.csv anchors (company tokens ∪
// ±21 day window, plus exact URL/fingerprint collapse — see scripts/cluster.ts).
// Runs once, up front, before any LLM calls: cheap in-memory union-find over at most
// a few thousand rows. `ClusterNode.idx` is the row's index in `queue`.
function buildQueueClusters(queue: LayoffEntry[], existingLayoffs: LayoffEntry[]): Cluster[] {
  if (queue.length === 0) return [];

  const tokens = buildCompanyTokens(existingLayoffs);
  const candidateNodes: ClusterNode[] = queue.map((r, idx) => ({
    idx,
    kind: 'candidate' as const,
    company: r.company || '',
    date_announced: r.date_announced || '',
    url: r.source_link || '',
    notes: r.notes || '',
    jobs_cut: r.jobs_cut_sg != null ? Number(r.jobs_cut_sg) : r.jobs_cut_global != null ? Number(r.jobs_cut_global) : null,
  }));
  const anchorNodes = anchorsFromLayoffs(existingLayoffs);
  return buildClusters([...candidateNodes, ...anchorNodes], tokens);
}

// Derive one ClusterHint per candidate queue row from the cluster set above.
function clusterHintsFromClusters(
  clusters: Cluster[],
  existingLayoffs: LayoffEntry[]
): Map<number, ClusterHint> {
  const hints = new Map<number, ClusterHint>();

  for (const cluster of clusters) {
    const candidateIdxs = cluster.members.filter((m) => m.kind === 'candidate').map((m) => m.idx);
    if (candidateIdxs.length === 0) continue;

    // All distinct existing events anchored to this cluster — the fallback list.
    const fallback: EventHint[] = [];
    const seen = new Set<string>();
    for (const m of cluster.members) {
      if (m.kind !== 'anchor') continue;
      const anchorEntry = existingLayoffs[m.idx];
      if (!anchorEntry?.event_id || seen.has(anchorEntry.event_id)) continue;
      seen.add(anchorEntry.event_id);
      fallback.push({ event_id: anchorEntry.event_id, date_announced: m.date_announced, company: m.company });
    }

    let primary: EventHint | null = null;
    if (cluster.hasAnchor) {
      const resolution = resolveCluster(cluster);
      if (resolution.kind === 'anchored') {
        const anchorEntry = existingLayoffs[resolution.anchor.idx];
        if (anchorEntry?.event_id) {
          primary = {
            event_id: anchorEntry.event_id,
            date_announced: resolution.anchor.date_announced,
            company: resolution.anchor.company,
          };
        }
      }
    }

    for (const idx of candidateIdxs) hints.set(idx, { primary, fallback });
  }

  return hints;
}

const MAX_LISTED_HINTS = 12;

function selectEventHints(
  entry: LayoffEntry,
  eventIndex: Map<string, EventHint[]>,
  clusterHint: ClusterHint
): EventHints {
  const hintMap = new Map<string, EventHint>();
  const exact = eventIndex.get(companyKey(entry.company || ''));
  for (const h of exact || []) hintMap.set(h.event_id, h);
  for (const h of clusterHint.fallback) hintMap.set(h.event_id, h);
  if (clusterHint.primary) hintMap.delete(clusterHint.primary.event_id);
  return { primary: clusterHint.primary, listed: [...hintMap.values()].slice(0, MAX_LISTED_HINTS) };
}

function allProvidersFailedVerdict(entry: LayoffEntry, errors: string[]): ModelVerdict {
  return {
    verdict: 'needs_review',
    confidence: 'low',
    company: entry.company,
    industry: 'Other',
    date_announced: entry.date_announced,
    date_reported: entry.date_reported,
    jobs_cut_sg: entry.jobs_cut_sg,
    jobs_cut_global: entry.jobs_cut_global,
    pct_workforce: entry.pct_workforce,
    event_id: null,
    notes: `All providers failed: ${errors.join(' | ')}`,
  };
}

function logDiscardedEventId(entry: LayoffEntry, discarded: string, hintedIds: string[]): void {
  const allowed = hintedIds.length > 0 ? hintedIds.join(', ') : 'none';
  console.log(
    `  ! ${entry.company.slice(0, 50)}: model proposed unlisted event_id "${discarded}" (allowed: ${allowed}) — treating as new event`
  );
}

async function evaluateEntry(
  chain: ProviderConfig[],
  entry: LayoffEntry,
  eventIndex: Map<string, EventHint[]>,
  clusterHint: ClusterHint
): Promise<{ verdict: ModelVerdict; provider: string }> {
  const hints = selectEventHints(entry, eventIndex, clusterHint);
  const hintedIds = hintedEventIds(hints);
  const { value, provider, errors } = await callJsonWithChain(chain, {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(entry, formatEventHints(hints)),
    parse: (raw) => parseModelVerdict(raw, hintedIds),
  });

  if (!value) return { verdict: allProvidersFailedVerdict(entry, errors), provider };
  if (value.discardedEventId) logDiscardedEventId(entry, value.discardedEventId, hintedIds);
  return { verdict: withEntryDefaults(value.verdict, entry), provider };
}

async function main() {
  const queue = readCsv('review-queue.csv') as LayoffEntry[];

  if (queue.length === 0) {
    console.log('Review queue is empty — nothing to triage.');
    fs.writeFileSync(
      'data/llm-triage-summary.json',
      JSON.stringify(
        { run_date: todayIso(), providers: [], total: 0, confirmed: 0, rumored: 0, rejected: 0, needs_review: 0, remaining_queue: 0, rows: [] },
        null,
        2
      ) + '\n'
    );
    return;
  }

  // Existing events index, so the model can reuse an event_id for follow-up coverage.
  // readCsv already returns [] for a missing/empty layoffs.csv, so an empty tracker
  // just means every cluster is candidate-only (no anchors) — handled below.
  const existingLayoffs = readCsv('layoffs.csv') as LayoffEntry[];
  const eventIndex = buildEventIndex(existingLayoffs);

  // Cluster review-queue candidates against layoffs.csv anchors up front — cheap,
  // one-shot union-find — so per-row hints and the post-verdict event_id alignment
  // below both reuse the same cluster set instead of reclustering per row.
  const clusters = buildQueueClusters(queue, existingLayoffs);
  const clusterHints = clusterHintsFromClusters(clusters, existingLayoffs);

  const chain = getProviderChain();
  const providerNames = describeChain(chain);
  console.log(`LLM triage: ${queue.length} entr${queue.length === 1 ? 'y' : 'ies'}`);
  console.log(`Provider chain: ${providerNames}\n`);

  const accepted: LayoffEntry[] = [];
  const rejected: LayoffEntry[] = [];
  const remaining: LayoffEntry[] = [];
  const summaryRows: SummaryRow[] = [];
  const originByRow = new Map<LayoffEntry, { entry: LayoffEntry; summary: SummaryRow }>();

  // Track the constructed layoffEntry per queue idx (only for confirmed/rumored rows)
  // so the post-loop cluster alignment below can look them up and mutate event_id in
  // place — the same object references live in `accepted`, so mutating here is
  // reflected there too.
  const acceptedByIdx = new Map<number, LayoffEntry>();

  // Overall wall-clock budget. The scheduled-scrape job is capped at 60 min; if triage
  // runs past that GitHub kills the process and NO progress is written (CSVs flush only
  // at the end), so the whole queue is re-triaged next run. Stop well before the cap,
  // leave any unprocessed rows in the queue, and flush what we have. Override with
  // TRIAGE_BUDGET_MS.
  const startedAt = Date.now();
  const budgetMs = Number(process.env.TRIAGE_BUDGET_MS) || 45 * 60_000;
  let timedOut = false;

  // Each entry is an independent, network-bound LLM call (~13s), so a large queue is
  // slow purely because it runs one at a time. Process a sliding window concurrently to
  // cut wall-clock roughly by the concurrency factor. Results are consumed in queue
  // order so routing, logging, and the summary stay deterministic. Keep concurrency
  // modest to avoid provider rate limits; override with TRIAGE_CONCURRENCY.
  const concurrency = Math.max(1, Number(process.env.TRIAGE_CONCURRENCY) || 5);
  let processed = 0;

  for (let start = 0; start < queue.length; start += concurrency) {
    if (Date.now() - startedAt > budgetMs) {
      // Out of time — keep this and every later row in the queue for the next run.
      timedOut = true;
      remaining.push(...queue.slice(start));
      console.log(
        `\n⏱  Time budget (${Math.round(budgetMs / 60_000)} min) exhausted after ${start}/${queue.length} entries — ` +
        `${queue.length - start} left in queue for next run.`
      );
      break;
    }

    const window = queue.slice(start, start + concurrency);
    const results = await Promise.all(
      window.map((entry, k) =>
        evaluateEntry(chain, entry, eventIndex, clusterHints.get(start + k) ?? NO_CLUSTER_HINT)
      )
    );

    for (let k = 0; k < window.length; k++) {
      const entry = window[k];
      const queueIdx = start + k;
      const { verdict, provider } = results[k];
      processed++;
      console.log(
        `  [${processed}/${queue.length}] ${entry.company.slice(0, 50).padEnd(50)} → ${verdict.verdict} (${verdict.confidence}) [${provider}]`
      );

      const summaryRow: SummaryRow = {
        original_company: entry.company,
        llm_company: verdict.company,
        source_link: entry.source_link,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        provider,
        notes: verdict.notes,
        rejection_reason: verdict.rejection_reason ?? undefined,
      };
      summaryRows.push(summaryRow);

      const date_announced = verdict.date_announced || entry.date_announced;
      const layoffEntry: LayoffEntry = {
        company: verdict.company,
        date_announced,
        date_reported: verdict.date_reported || entry.date_reported || entry.date_announced,
        jobs_cut_sg: verdict.jobs_cut_sg,
        jobs_cut_global: verdict.jobs_cut_global,
        pct_workforce: verdict.pct_workforce,
        industry: verdict.industry,
        source_link: entry.source_link,
        notes: verdict.notes,
        status: (verdict.verdict === 'confirmed' || verdict.verdict === 'rumored')
          ? verdict.verdict
          : (entry.status as LayoffEntry['status']) || 'rumored',
        event_id: verdict.event_id || entry.event_id || eventIdFor(verdict.company, date_announced),
      };

      if (verdict.verdict === 'confirmed' || verdict.verdict === 'rumored') {
        accepted.push(layoffEntry);
        acceptedByIdx.set(queueIdx, layoffEntry);
        originByRow.set(layoffEntry, { entry, summary: summaryRow });
      } else if (verdict.verdict === 'rejected') {
        const rejectedEntry: LayoffEntry = {
          ...layoffEntry,
          notes: `[LLM rejected: ${verdict.rejection_reason || 'see notes'}] ${verdict.notes}`,
        };
        rejected.push(rejectedEntry);
        originByRow.set(rejectedEntry, { entry, summary: summaryRow });
      } else {
        remaining.push(entry);
      }
    }
  }

  // Candidates that clustered only with each other (no layoffs.csv anchor) may each
  // have been triaged independently and minted their own event_id. Align them: for
  // every non-anchored cluster with ≥2 accepted candidates, adopt the canonical row's
  // (per resolveCluster) event_id across the whole cluster so they count as one event.
  for (const cluster of clusters) {
    if (cluster.hasAnchor) continue;
    const candidateIdxs = cluster.members.filter((m) => m.kind === 'candidate').map((m) => m.idx);
    if (candidateIdxs.length < 2) continue;

    const resolution = resolveCluster(cluster);
    if (resolution.kind !== 'canonical') continue;

    const canonicalEntry = acceptedByIdx.get(resolution.canonicalIdx);
    if (!canonicalEntry) continue; // canonical row wasn't accepted — nothing to align to
    const canonicalEventId = canonicalEntry.event_id;

    for (const idx of candidateIdxs) {
      if (idx === resolution.canonicalIdx) continue;
      const row = acceptedByIdx.get(idx);
      if (!row || row.event_id === canonicalEventId) continue;
      console.log(
        `  ↳ linking ${row.company} (${row.date_announced}) ${row.event_id} → ${canonicalEventId} ` +
        `(clustered with ${canonicalEntry.company}, row ${resolution.canonicalIdx})`
      );
      row.event_id = canonicalEventId;
    }
  }

  const candidates: TriageCandidate[] = [
    ...accepted.map((row) => ({ target: 'layoffs' as const, row })),
    ...rejected.map((row) => ({ target: 'rejected' as const, row })),
  ];
  const screened = screenTriageBatch(existingLayoffs, readCsv('rejected.csv') as LayoffEntry[], candidates, datasetAnalyzer());
  for (const held of screened.heldBack) {
    const origin = originByRow.get(held.candidate.row);
    if (!origin) continue;
    remaining.push(origin.entry);
    origin.summary.verdict = 'needs_review';
    console.log(`  ! held back ${held.candidate.row.company} (${held.candidate.row.date_announced}) for manual review:`);
    for (const warning of held.warnings) console.log(`      [${warning.type}] ${warning.message}`);
  }

  if (screened.accepted.length > 0) appendCsv('layoffs.csv', screened.accepted);
  if (screened.rejected.length > 0) appendCsv('rejected.csv', screened.rejected);
  writeCsv('review-queue.csv', remaining);

  const summary = {
    run_date: todayIso(),
    providers: chain.map((p) => ({ name: p.name, model: p.model })),
    timed_out: timedOut,
    total: summaryRows.length,
    confirmed: summaryRows.filter((r) => r.verdict === 'confirmed').length,
    rumored: summaryRows.filter((r) => r.verdict === 'rumored').length,
    rejected: summaryRows.filter((r) => r.verdict === 'rejected').length,
    needs_review: summaryRows.filter((r) => r.verdict === 'needs_review').length,
    remaining_queue: remaining.length,
    rows: summaryRows,
  };

  fs.writeFileSync('data/llm-triage-summary.json', JSON.stringify(summary, null, 2) + '\n');

  console.log(`
Summary:
  Provider chain  : ${providerNames}
  Total evaluated : ${summary.total}
  Confirmed       : ${summary.confirmed}
  Rumored         : ${summary.rumored}
  Rejected        : ${summary.rejected}
  Needs review    : ${summary.needs_review}
  Remaining queue : ${summary.remaining_queue}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
