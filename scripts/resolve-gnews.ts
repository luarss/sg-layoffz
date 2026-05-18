// Batch resolve Google News RSS article URLs to canonical publisher URLs.
//
// Approach (used by community decoders like SSujitX/google-news-url-decoder):
//   1. Warm up a session by visiting https://news.google.com/ so we get
//      NID + GN_PREF cookies. Subsequent requests without these are blocked
//      (Google returns an empty body or interstitial).
//   2. GET the article page and scrape the `data-n-a-sg` (signature) and
//      `data-n-a-ts` (timestamp) attributes.
//   3. POST those to the `Fbv4je` batchexecute RPC; the response contains the
//      canonical URL.
//
// Older-style URLs (where the decoded base64 payload does not start with
// "AU_yqL") encode the canonical URL directly and can be decoded offline.

import fs from 'node:fs';
import { readCsv } from '../src/lib/csv';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const REQUEST_DELAY_MS = 750;
const MAX_RETRIES = 3;

let cookieHeader = '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function warmUpSession(): Promise<void> {
  const res = await fetch('https://news.google.com/', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  const setCookies = (res.headers as any).getSetCookie?.() as string[] | undefined;
  const cookies: string[] = [];
  if (setCookies && setCookies.length) {
    for (const c of setCookies) cookies.push(c.split(';')[0]);
  } else {
    // Fallback: single set-cookie header
    const single = res.headers.get('set-cookie');
    if (single) cookies.push(single.split(';')[0]);
  }
  cookieHeader = cookies.join('; ');
  if (!cookieHeader) {
    throw new Error('Failed to obtain session cookies from news.google.com');
  }
  console.log(`Session warmed up (cookies: ${cookieHeader.slice(0, 80)}...)`);
}

function extractBase64Id(googleNewsUrl: string): string | null {
  try {
    const u = new URL(googleNewsUrl);
    if (u.hostname !== 'news.google.com') return null;
    const parts = u.pathname.split('/');
    const articlesIdx = parts.indexOf('articles');
    if (articlesIdx === -1) return null;
    return parts[articlesIdx + 1] || null;
  } catch {
    return null;
  }
}

function decodeOfflineOldStyle(base64Id: string): string | null {
  let str = Buffer.from(base64Id, 'base64').toString('binary');

  const prefix = Buffer.from([0x08, 0x13, 0x22]).toString('binary');
  if (str.startsWith(prefix)) str = str.substring(prefix.length);

  const suffix = Buffer.from([0xd2, 0x01, 0x00]).toString('binary');
  if (str.endsWith(suffix)) str = str.substring(0, str.length - suffix.length);

  const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0));
  const len = bytes.at(0);
  if (len === undefined) return null;

  let payload: string;
  if (len >= 0x80) payload = str.substring(2, len + 2);
  else payload = str.substring(1, len + 1);

  if (payload.startsWith('AU_yqL')) return null;
  if (!payload.startsWith('http')) return null;
  return payload;
}

interface ArticleParams {
  signature: string;
  timestamp: string;
  base64Id: string;
}

async function fetchArticleParams(base64Id: string): Promise<ArticleParams> {
  const articleUrl = `https://news.google.com/rss/articles/${base64Id}?oc=5&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(articleUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Cookie: cookieHeader,
    },
    redirect: 'follow',
  });
  const html = await res.text();

  const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
  const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sigMatch || !tsMatch) {
    throw new Error(`Article page missing data-n-a-sg/ts (status ${res.status}, ${html.length} bytes)`);
  }
  return { signature: sigMatch[1], timestamp: tsMatch[1], base64Id };
}

// Walk a JSON string and return the index of the character that closes the
// first top-level array/object. Returns -1 if no balanced close is found.
function findFirstJsonEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

async function resolveViaBatchExecute(params: ArticleParams): Promise<string> {
  const innerPayload = [
    'garturlreq',
    [
      ['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
      'X',
      'X',
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    params.base64Id,
    parseInt(params.timestamp, 10),
    params.signature,
  ];
  const rpcEntry = ['Fbv4je', JSON.stringify(innerPayload), null, 'generic'];
  const fReq = JSON.stringify([[rpcEntry]]);

  const res = await fetch(
    'https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': USER_AGENT,
        Cookie: cookieHeader,
      },
      body: 'f.req=' + encodeURIComponent(fReq),
    }
  );
  const text = await res.text();

  try {
    return parseBatchExecuteResponse(text);
  } catch (e) {
    // Write the bad response to a file for inspection
    try {
      fs.writeFileSync('/tmp/bad-gn-resp.txt', text);
    } catch {}
    throw new Error(`${(e as Error).message} (status ${res.status}, body saved to /tmp/bad-gn-resp.txt)`);
  }
}

function parseBatchExecuteResponse(text: string): string {
  // batchexecute responses look like:
  //   )]}'\n\n<chunklen>\n[[["wrb.fr","Fbv4je","<json-string>",null,null,null,"generic"], ...]]
  // followed by more length-prefixed JSON chunks. We just need the first chunk.
  const cleaned = text.replace(/^\)\]\}'\s*/, '');
  // Strip the leading <number>\n length marker, then parse the JSON array.
  const lenStripped = cleaned.replace(/^\d+\s*/, '');
  // Take the first balanced top-level JSON array.
  const firstClose = findFirstJsonEnd(lenStripped);
  if (firstClose < 0) {
    throw new Error(`Unparseable batchexecute response: ${text.slice(0, 200)}`);
  }
  const chunk = JSON.parse(lenStripped.slice(0, firstClose + 1));
  // chunk is an array of RPC results; find the Fbv4je entry
  const entry = (chunk as any[]).find(
    (e) => Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === 'Fbv4je'
  );
  if (!entry || typeof entry[2] !== 'string') {
    throw new Error(`No Fbv4je entry in response: ${text.slice(0, 200)}`);
  }
  const innerArr = JSON.parse(entry[2]) as unknown[];
  if (!Array.isArray(innerArr) || innerArr[0] !== 'garturlres' || typeof innerArr[1] !== 'string') {
    throw new Error(`Unexpected inner payload: ${entry[2].slice(0, 200)}`);
  }
  return innerArr[1];
}

async function decodeGoogleNewsUrl(sourceUrl: string): Promise<string> {
  const id = extractBase64Id(sourceUrl);
  if (!id) return sourceUrl;

  try {
    const offline = decodeOfflineOldStyle(id);
    if (offline) return offline;
  } catch {
    // fall through to online resolution
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const params = await fetchArticleParams(id);
      return await resolveViaBatchExecute(params);
    } catch (e) {
      lastErr = e;
      // On failure, sleep with backoff and try once more
      if (attempt < MAX_RETRIES) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

async function main() {
  const queue = readCsv('review-queue.csv') as any[];
  console.log(`Resolving ${queue.length} URLs...`);

  await warmUpSession();

  const out: any[] = [];
  let resolved = 0;
  let failed = 0;
  for (const row of queue) {
    const original = row.source_link as string;
    let canonical = original;
    if (original && original.includes('news.google.com')) {
      try {
        canonical = await decodeGoogleNewsUrl(original);
        resolved++;
      } catch (e) {
        failed++;
        console.error(`FAIL row(${(row.company || '').slice(0, 40)}): ${(e as Error).message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
    out.push({ ...row, canonical_url: canonical });
    if ((resolved + failed) > 0 && (resolved + failed) % 25 === 0) {
      console.log(`  ${resolved + failed}/${queue.length} (ok=${resolved}, fail=${failed})`);
    }
  }
  console.log(`\nResolved ${resolved}, failed ${failed}`);

  fs.writeFileSync(
    `${process.cwd()}/data/review-queue-resolved.json`,
    JSON.stringify(out, null, 2)
  );
  console.log('Wrote data/review-queue-resolved.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
