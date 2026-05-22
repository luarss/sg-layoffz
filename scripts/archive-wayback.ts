/**
 * Archive layoffs.csv source links to the Internet Archive via SPN2,
 * then rewrite each row's source_link to its Wayback permalink.
 *
 * Usage:
 *   IA_ACCESS_KEY=... IA_SECRET_KEY=... npx tsx scripts/archive-wayback.ts
 *
 * Flags:
 *   --file <name>     CSV file in data/ (default: layoffs.csv)
 *   --statuses <csv>  Statuses to archive (default: confirmed,rumored)
 *   --dry-run         Print what would change without writing
 *   --limit <n>       Process at most N rows
 *   --start <n>       Skip the first N eligible rows (resume)
 */

import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';
import { readCsv, writeCsv } from '../src/lib/csv';
import { LayoffEntry } from '../src/lib/types';

// Force IPv4 + generous connect timeout — IPv6 to archive.org sometimes hangs
setGlobalDispatcher(
  new Agent({
    connect: {
      timeout: 30_000,
      lookup: (hostname, options, cb) => lookup(hostname, { ...options, family: 4 }, cb),
    },
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
  })
);

const SPN_ENDPOINT = 'https://web.archive.org/save';
const STATUS_ENDPOINT = 'https://web.archive.org/save/status';
const AVAILABILITY_ENDPOINT = 'https://archive.org/wayback/available';

interface Args {
  file: string;
  statuses: Set<string>;
  dryRun: boolean;
  limit: number;
  start: number;
  perMinute: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    file: 'layoffs.csv',
    statuses: new Set(['confirmed', 'rumored']),
    dryRun: false,
    limit: Infinity,
    start: 0,
    // SPN2 authenticated cap is 15/min. Default to 10/min for headroom.
    perMinute: 10,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file') out.file = args[++i];
    else if (a === '--statuses') out.statuses = new Set(args[++i].split(','));
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Number(args[++i]);
    else if (a === '--start') out.start = Number(args[++i]);
    else if (a === '--per-minute') out.perMinute = Number(args[++i]);
  }
  return out;
}

function loadDotEnv() {
  const p = path.join(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface SpnSubmitResponse {
  job_id?: string;
  url?: string;
  message?: string;
  status?: string;
  status_ext?: string;
}

interface SpnStatusResponse {
  status: 'pending' | 'success' | 'error';
  job_id: string;
  original_url?: string;
  timestamp?: string;
  message?: string;
  status_ext?: string;
  exception?: string;
}

class RateLimited extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterFromHeaders(headers: Headers): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (!Number.isNaN(n)) return n * 1000;
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  }
  return null;
}

async function submitSave(url: string, auth: string): Promise<SpnSubmitResponse> {
  const body = new URLSearchParams({
    url,
    capture_all: '1',
    skip_first_archive: '1',
    if_not_archived_within: '30d',
  });
  const res = await fetch(SPN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (res.status === 429) {
    const wait = retryAfterFromHeaders(res.headers) ?? 60_000;
    throw new RateLimited(`HTTP 429 from SPN submit`, wait);
  }

  const text = await res.text();
  let json: SpnSubmitResponse;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`SPN submit non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  // SPN sometimes returns 200 with {status:'error', status_ext:'error:user-session-limit'}
  if (!json.job_id && /limit|too many|exceed/i.test(`${json.status_ext || ''} ${json.message || ''}`)) {
    throw new RateLimited(`SPN reports limit: ${json.status_ext || json.message}`, 60_000);
  }

  return json;
}

async function pollStatus(jobId: string, auth: string, maxWaitMs = 180_000): Promise<SpnStatusResponse> {
  const deadline = Date.now() + maxWaitMs;
  let delay = 4000;
  while (Date.now() < deadline) {
    await sleep(delay);
    const res = await fetch(`${STATUS_ENDPOINT}/${jobId}`, {
      headers: { Accept: 'application/json', Authorization: auth },
    });
    const text = await res.text();
    let json: SpnStatusResponse;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`SPN status non-JSON (${res.status}): ${text.slice(0, 300)}`);
    }
    if (json.status === 'success' || json.status === 'error') return json;
    // pending: back off slightly
    delay = Math.min(delay + 2000, 12_000);
  }
  throw new Error(`Timed out waiting for SPN job ${jobId}`);
}

function waybackUrl(timestamp: string, originalUrl: string): string {
  return `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}

interface AvailabilityResponse {
  archived_snapshots?: {
    closest?: { available: boolean; url: string; timestamp: string; status: string };
  };
}

async function checkAvailability(url: string): Promise<{ timestamp: string } | null> {
  const u = `${AVAILABILITY_ENDPOINT}?url=${encodeURIComponent(url)}`;
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const json = (await res.json()) as AvailabilityResponse;
  const c = json.archived_snapshots?.closest;
  if (c && c.available && c.timestamp) return { timestamp: c.timestamp };
  return null;
}

async function main() {
  loadDotEnv();
  const args = parseArgs();

  const access = process.env.IA_ACCESS_KEY;
  const secret = process.env.IA_SECRET_KEY;
  if (!access || !secret) {
    console.error('Missing IA_ACCESS_KEY / IA_SECRET_KEY in environment or .env');
    process.exit(1);
  }
  const auth = `LOW ${access}:${secret}`;

  const entries = readCsv(args.file);
  console.log(`Loaded ${entries.length} rows from ${args.file}`);

  const eligibleIdx: number[] = [];
  entries.forEach((e, i) => {
    const url = String(e.source_link || '');
    if (!url) return;
    if (url.includes('web.archive.org')) return;
    if (!args.statuses.has(String(e.status))) return;
    eligibleIdx.push(i);
  });

  const pacingMs = Math.ceil(60_000 / Math.max(1, args.perMinute));
  console.log(
    `${eligibleIdx.length} eligible rows (statuses: ${[...args.statuses].join(',')})` +
      (args.start ? `, starting at offset ${args.start}` : '') +
      (Number.isFinite(args.limit) ? `, limit ${args.limit}` : '') +
      `, pacing ${args.perMinute}/min (${pacingMs}ms between submits)`
  );

  const slice = eligibleIdx.slice(args.start, args.start + (Number.isFinite(args.limit) ? args.limit : eligibleIdx.length));

  let changed = 0;
  let failed = 0;
  const failures: { row: number; url: string; reason: string }[] = [];

  for (let n = 0; n < slice.length; n++) {
    const rowIdx = slice[n];
    const entry = entries[rowIdx];
    const url = String(entry.source_link);
    const label = `[${n + 1}/${slice.length}] row ${rowIdx + 2} ${entry.company}`;
    process.stdout.write(`${label} -> submitting…\n`);

    let succeeded = false;
    for (let attempt = 1; attempt <= 4 && !succeeded; attempt++) {
      try {
        let timestamp: string | null = null;
        try {
          const submit = await submitSave(url, auth);
          if (!submit.job_id) {
            const reason = submit.message || submit.status_ext || submit.status || JSON.stringify(submit);
            throw new Error(`no job_id: ${reason}`);
          }
          const status = await pollStatus(submit.job_id, auth);
          if (status.status !== 'success' || !status.timestamp) {
            throw new Error(`job ${submit.job_id} ${status.status}: ${status.message || status.status_ext || status.exception || ''}`);
          }
          timestamp = status.timestamp;
        } catch (subErr) {
          const msg = subErr instanceof Error ? subErr.message : String(subErr);
          // SPN refuses to recapture URLs snapshotted recently — fall back to the existing snapshot.
          if (/same snapshot had been made|You can make new capture of this URL after/i.test(msg)) {
            const existing = await checkAvailability(url);
            if (!existing) throw subErr;
            console.log(`  ↩ reusing existing snapshot (${existing.timestamp})`);
            timestamp = existing.timestamp;
          } else {
            throw subErr;
          }
        }

        // Build the permalink from the URL we submitted, NOT from SPN's
        // returned original_url — some sites (e.g. straitstimes.com) redirect
        // to an unrelated article, and the snapshot itself is keyed on the
        // submitted URL anyway.
        const newUrl = waybackUrl(timestamp!, url);
        console.log(`  ✔ ${newUrl}`);
        if (!args.dryRun) {
          entries[rowIdx].source_link = newUrl;
          writeCsv(args.file, entries as LayoffEntry[]);
        }
        changed++;
        succeeded = true;
      } catch (err) {
        if (err instanceof RateLimited) {
          const wait = err.retryAfterMs;
          console.warn(`  ⏸ rate limited; sleeping ${Math.round(wait / 1000)}s (attempt ${attempt}/4)`);
          await sleep(wait);
          continue;
        }
        // Transient network errors — short backoff and retry
        const code = err instanceof Error ? (err as any).cause?.code : undefined;
        if (attempt < 4 && (code === 'ECONNRESET' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET' || code === 'ETIMEDOUT')) {
          console.warn(`  ↻ network error (${code}); retry ${attempt}/4 in 10s`);
          await sleep(10_000);
          continue;
        }
        const cause = err instanceof Error && (err as any).cause ? ` (cause: ${(err as any).cause?.code || (err as any).cause?.message || String((err as any).cause)})` : '';
        const reason = (err instanceof Error ? err.message : String(err)) + cause;
        console.error(`  ✗ ${reason}`);
        failures.push({ row: rowIdx + 2, url, reason });
        failed++;
        break;
      }
    }

    if (n < slice.length - 1) await sleep(pacingMs);
  }

  console.log(`\nDone. updated=${changed} failed=${failed} of ${slice.length}`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  row ${f.row} ${f.url} — ${f.reason}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
