// Shared search helpers used by the scrapers (scrape-google-news.ts, scrape-exa.ts)
// and the rumor-recheck lifecycle (rumor-recheck.ts). Centralising the Google News
// RSS and Exa search calls here means the recheck flow reuses the exact same coverage
// sources as the daily scrape instead of duplicating the request/parsing logic.

import Parser from 'rss-parser';

const parser = new Parser();

// A normalized search result shared across every source. `publishedDate` and
// `source` may be empty when the upstream API omits them.
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string;
  source: string;
}

// Fingerprint a headline: strip the trailing "- Source Name" suffix, lowercase,
// keep the first six alphanumeric words. Used as a secondary dedup key (the same
// article arrives under different opaque wrapper URLs across queries) and stored
// in `notes` so future runs can recognise a repeat.
export function titleFingerprint(title: string): string {
  return title
    .replace(/ [-–] [^-–\n]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

// Job boards and recruiting sites excluded at the Exa API level via excludeDomains.
export const EXA_EXCLUDED_DOMAINS = [
  'accaglobal.com',
  'alchemygts.com',
  'frazerjones.com',
  'gaapweb.com',
  'glassdoor.com',
  'hireza.wuaze.com',
  'indeed.com',
  'interimsearch.com',
  'jobsdb.com',
  'linkedin.com',
  'mycareersfuture.gov.sg',
  'nicollcurtin.com',
  'seek.com',
  'totallylegal.com',
];

// Query Google News RSS (free, unlimited) for a single query and return the items
// as normalized SearchHits. Failures are logged and yield an empty list so a single
// bad query never aborts a run.
export async function searchGoogleNews(query: string): Promise<SearchHit[]> {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-SG&gl=SG&ceid=SG:en`;
  const results: SearchHit[] = [];
  const t0 = Date.now();

  try {
    const feed = await parser.parseURL(rssUrl);
    console.log(`    [timing] "${query}": ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    for (const item of feed.items || []) {
      if (!item.title || !item.link) continue;
      results.push({
        title: item.title,
        url: item.link,
        snippet: (item.contentSnippet || item.content || '').replace(/\r/g, ''),
        publishedDate: item.pubDate || '',
        source: item.source?.name || 'Google News',
      });
    }
  } catch (err) {
    console.error(`    [timing] "${query}": FAILED after ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    console.error(`Failed to fetch RSS for "${query}":`, err);
  }

  return results;
}

export interface ExaSearchOptions {
  numResults?: number;
  startPublishedDate?: string;
  endPublishedDate?: string;
  maxCharacters?: number;
  excludeDomains?: string[];
  type?: string;
}

interface ExaApiResult {
  url: string;
  title?: string;
  publishedDate?: string;
  text?: string;
  author?: string;
}

// Query the Exa semantic search API for a single query and return normalized
// SearchHits. Throws on a non-2xx response so callers can decide how to handle
// budget/rate-limit errors.
export async function searchExa(
  apiKey: string,
  query: string,
  opts: ExaSearchOptions = {}
): Promise<SearchHit[]> {
  const {
    numResults = 10,
    startPublishedDate,
    endPublishedDate,
    maxCharacters = 800,
    excludeDomains = EXA_EXCLUDED_DOMAINS,
    type = 'auto',
  } = opts;

  const t0 = Date.now();
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults,
      type,
      ...(startPublishedDate ? { startPublishedDate } : {}),
      ...(endPublishedDate ? { endPublishedDate } : {}),
      excludeDomains,
      contents: { text: { maxCharacters } },
    }),
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Exa ${res.status}: ${body.slice(0, 200)} (${elapsed}s)`);
  }
  const data = (await res.json()) as { results?: ExaApiResult[] };
  console.log(`    [timing] "${query}": ${elapsed}s`);
  return (data.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: r.text || '',
    publishedDate: r.publishedDate || '',
    source: r.author || 'Exa',
  }));
}

// ---------------------------------------------------------------------------
// TinyFish fallback (https://tinyfish.ai) — a drop-in for the two paid halves of
// our coverage pipeline: Search (below) and Fetch/extract (`fetchTinyFish`).
// Both are gated on TINYFISH_API_KEY by callers, so with no key the pipeline
// behaves exactly as before. Search & Fetch are free on TinyFish, which makes it
// a natural safety net when Exa's monthly budget is exhausted or a request fails,
// and when a publisher Cloudflare-blocks our direct fetches.
// ---------------------------------------------------------------------------

const TINYFISH_SEARCH_ENDPOINT = 'https://api.search.tinyfish.ai';
const TINYFISH_FETCH_ENDPOINT = 'https://api.fetch.tinyfish.ai';

export interface TinyFishSearchOptions {
  numResults?: number;
  // Accepts ISO 8601 or YYYY-MM-DD; TinyFish's after_date/before_date want the
  // calendar date, so we truncate to the first 10 chars.
  startPublishedDate?: string;
  endPublishedDate?: string;
  excludeDomains?: string[];
  location?: string;
  language?: string;
  domainType?: 'web' | 'news' | 'research_paper';
}

interface TinyFishSearchResult {
  position?: number;
  site_name?: string;
  title?: string;
  snippet?: string;
  url?: string;
  // Present when domain_type=news.
  publisher?: string;
  date?: string;
}

// True if `url`'s host is (a subdomain of) any excluded domain. TinyFish has no
// server-side excludeDomains param, so we filter the job-board/recruiter noise
// client-side to match Exa's behaviour.
function hostIsExcluded(url: string, excluded: Set<string>): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const d of excluded) {
      if (host === d || host.endsWith(`.${d}`)) return true;
    }
  } catch {
    // Unparseable URL — let it through; dedup downstream will handle it.
  }
  return false;
}

// Query the TinyFish Search API and return normalized SearchHits. Throws on a
// non-2xx response so callers can decide how to react, mirroring searchExa.
export async function searchTinyFish(
  apiKey: string,
  query: string,
  opts: TinyFishSearchOptions = {}
): Promise<SearchHit[]> {
  const {
    numResults = 10,
    startPublishedDate,
    endPublishedDate,
    excludeDomains = EXA_EXCLUDED_DOMAINS,
    location = 'Singapore',
    language = 'en',
    domainType = 'news',
  } = opts;

  const params = new URLSearchParams({ query });
  if (location) params.set('location', location);
  if (language) params.set('language', language);
  if (domainType) params.set('domain_type', domainType);
  if (startPublishedDate) params.set('after_date', startPublishedDate.slice(0, 10));
  if (endPublishedDate) params.set('before_date', endPublishedDate.slice(0, 10));

  const t0 = Date.now();
  const res = await fetch(`${TINYFISH_SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: { 'X-API-Key': apiKey },
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TinyFish search ${res.status}: ${body.slice(0, 200)} (${elapsed}s)`);
  }
  const data = (await res.json()) as { results?: TinyFishSearchResult[] };
  console.log(`    [timing] "${query}": ${elapsed}s`);

  const excluded = new Set(excludeDomains.map((d) => d.toLowerCase()));
  return (data.results || [])
    .filter((r): r is TinyFishSearchResult & { url: string } =>
      Boolean(r.url) && !hostIsExcluded(r.url!, excluded)
    )
    .slice(0, numResults)
    .map((r) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.snippet || '',
      publishedDate: r.date || '',
      source: r.publisher || r.site_name || 'TinyFish',
    }));
}

export interface TinyFishFetchResult {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
}

interface TinyFishFetchApiResult {
  url?: string;
  final_url?: string;
  title?: string;
  text?: string;
}

// Fetch (render) one or more URLs through TinyFish's real-browser Fetch API and
// return the extracted content. Used as a last-resort extractor when a publisher
// blocks our direct requests (Cloudflare et al.). Throws on a non-2xx response.
export async function fetchTinyFish(
  apiKey: string,
  urls: string[],
  format: 'markdown' | 'html' | 'json' = 'markdown'
): Promise<TinyFishFetchResult[]> {
  const res = await fetch(TINYFISH_FETCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    // API caps a single request at 10 URLs.
    body: JSON.stringify({ urls: urls.slice(0, 10), format }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TinyFish fetch ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { results?: TinyFishFetchApiResult[] };
  return (data.results || []).map((r) => ({
    url: r.url || '',
    finalUrl: r.final_url || r.url || '',
    title: r.title || '',
    text: r.text || '',
  }));
}

// ---------------------------------------------------------------------------
// Keenable fallback (https://keenable.ai) — the final, keyless tier below Exa
// and TinyFish. Keenable is keyless by default (KEENABLE_API_KEY only raises
// rate limits), so it works without any secret and its `/public` endpoints are
// used when no key is present. Provides both Search and Fetch/extract.
// ---------------------------------------------------------------------------

const KEENABLE_SEARCH_ENDPOINT = 'https://api.keenable.ai/v1/search';
const KEENABLE_FETCH_ENDPOINT = 'https://api.keenable.ai/v1/fetch';
// Identifies this app on Keenable's public (keyless) endpoints, where the
// X-Keenable-Title header is required.
const KEENABLE_APP_TITLE = 'sg-layoffz';

export interface KeenableSearchOptions {
  numResults?: number;
  // ISO 8601 or YYYY-MM-DD; truncated to the calendar date Keenable expects.
  startPublishedDate?: string;
  endPublishedDate?: string;
  excludeDomains?: string[];
  // Optional; falls back to KEENABLE_API_KEY, then to the keyless public endpoint.
  apiKey?: string;
}

interface KeenableSearchResult {
  title?: string;
  url?: string;
  description?: string;
  snippets?: string[] | string;
  published_at?: string;
}

// Resolve the Keenable key (explicit arg > env) and return the endpoint URL and
// headers to use — the authenticated endpoint when keyed, the public one when not.
function keenableAuth(endpoint: string, apiKey?: string): { url: string; headers: Record<string, string> } {
  const key = apiKey ?? process.env.KEENABLE_API_KEY;
  if (key) {
    return { url: endpoint, headers: { 'X-API-Key': key } };
  }
  return { url: `${endpoint}/public`, headers: { 'X-Keenable-Title': KEENABLE_APP_TITLE } };
}

// Query the Keenable Search API and return normalized SearchHits. Throws on a
// non-2xx response, mirroring searchExa/searchTinyFish.
export async function searchKeenable(
  query: string,
  opts: KeenableSearchOptions = {}
): Promise<SearchHit[]> {
  const {
    numResults = 10,
    startPublishedDate,
    endPublishedDate,
    excludeDomains = EXA_EXCLUDED_DOMAINS,
    apiKey,
  } = opts;

  const { url, headers } = keenableAuth(KEENABLE_SEARCH_ENDPOINT, apiKey);
  const body: Record<string, string> = { query };
  if (startPublishedDate) body.published_after = startPublishedDate.slice(0, 10);
  if (endPublishedDate) body.published_before = endPublishedDate.slice(0, 10);

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Keenable search ${res.status}: ${errBody.slice(0, 200)} (${elapsed}s)`);
  }
  const data = (await res.json()) as { results?: KeenableSearchResult[] };
  console.log(`    [timing] "${query}": ${elapsed}s`);

  const excluded = new Set(excludeDomains.map((d) => d.toLowerCase()));
  return (data.results || [])
    .filter((r): r is KeenableSearchResult & { url: string } =>
      Boolean(r.url) && !hostIsExcluded(r.url!, excluded)
    )
    .slice(0, numResults)
    .map((r) => {
      const snippet =
        r.description ||
        (Array.isArray(r.snippets) ? r.snippets.join(' ') : r.snippets) ||
        '';
      let source = 'Keenable';
      try {
        source = new URL(r.url).hostname.replace(/^www\./, '');
      } catch {
        // keep default
      }
      return {
        title: r.title || r.url,
        url: r.url,
        snippet,
        publishedDate: r.published_at || '',
        source,
      };
    });
}

export interface KeenableFetchResult {
  url: string;
  title: string;
  text: string;
}

// Fetch (extract) a single URL through Keenable, returning clean markdown. Uses
// live=true so arbitrary (non-indexed) news URLs are fetched from source rather
// than requiring them to be in Keenable's index. Throws on a non-2xx response.
export async function fetchKeenable(
  targetUrl: string,
  apiKey?: string
): Promise<KeenableFetchResult> {
  const { url, headers } = keenableAuth(KEENABLE_FETCH_ENDPOINT, apiKey);
  const qs = new URLSearchParams({ url: targetUrl, live: 'true' });
  const res = await fetch(`${url}?${qs.toString()}`, { headers });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Keenable fetch ${res.status}: ${errBody.slice(0, 200)}`);
  }

  // The endpoint may return either a JSON envelope or raw markdown; handle both.
  const raw = await res.text();
  try {
    const data = JSON.parse(raw) as {
      title?: string;
      content?: string;
      markdown?: string;
      text?: string;
    };
    return {
      url: targetUrl,
      title: data.title || '',
      text: data.content || data.markdown || data.text || '',
    };
  } catch {
    return { url: targetUrl, title: '', text: raw };
  }
}
