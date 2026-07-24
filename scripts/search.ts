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
