import Parser from 'rss-parser';
import https from 'node:https';
import http from 'node:http';
import { readCsv, appendCsv } from '../src/lib/csv';
import { ReviewEntry } from '../src/lib/types';
import { normalizeCompany, parseDate, extractJobsFromText } from './normalize';
import { isDuplicate } from './deduplicate';

const parser = new Parser();

interface FeedConfig {
  name: string;
  url: string;
}

// Curated Singapore feeds with the strongest signal for layoff/retrenchment coverage.
// Business Times verticals first (economy + SME run most stories), then CNA/ST for
// breaking news, then general SG outlets as a wider net.
const FEEDS: FeedConfig[] = [
  { name: 'Business Times — Economy & Policy', url: 'https://www.businesstimes.com.sg/rss/economy-policy' },
  { name: 'Business Times — Singapore', url: 'https://www.businesstimes.com.sg/rss/singapore' },
  { name: 'Business Times — SGSME', url: 'https://www.businesstimes.com.sg/rss/sgsme' },
  { name: 'CNA — Singapore', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416' },
  { name: 'Straits Times — Singapore', url: 'https://www.straitstimes.com/news/singapore/rss.xml' },
  { name: 'Mothership', url: 'https://mothership.sg/feed' },
  { name: 'Vulcan Post — Singapore', url: 'https://vulcanpost.com/tag/singapore/feed/' },
  { name: 'AsiaOne', url: 'https://www.asiaone.com/rss-feed/2' },
];

const LAYOFF_TERMS = [
  'layoff',
  'laid off',
  'job cut',
  'jobs cut',
  'retrench',
  'redundanc',
  'restructur',
  'downsiz',
  'workforce reduction',
  'headcount',
  'sheds jobs',
  'cuts jobs',
];

interface RawCandidate {
  title: string;
  url: string;
  snippet: string;
  pubDate: string;
  source: string;
}

// Fingerprint by title (stripped source suffix, first 6 words) so the same article
// surfaced in multiple feeds within one run gets deduped, and `notes` carries the
// fingerprint forward so subsequent runs can match it via isDuplicate.
function titleFingerprint(title: string): string {
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

function isRelevant(title: string, snippet: string): boolean {
  const combined = `${title} ${snippet}`.toLowerCase();
  // Some feeds (Vulcan Post / Mothership) are SG-default so don't require the
  // word "singapore"; others (BT/CNA/ST) are SG-by-publication. The layoff term
  // is the binding constraint either way.
  return LAYOFF_TERMS.some((term) => combined.includes(term));
}

// Fetch a URL via Node's https module (matches rss-parser's transport, so it gets
// through Cloudflare on feeds like Mothership where undici-based `fetch` is 403'd).
function fetchRaw(url: string, redirectsLeft = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'rss-parser', Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          req.destroy();
          const next = new URL(res.headers.location, url).toString();
          resolve(fetchRaw(next, redirectsLeft - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          req.destroy();
          reject(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
  });
}

// Fetch + parse with a sanitization fallback: some feeds (e.g. Mothership) emit
// unescaped `&` characters that break the strict xml2js/sax parser. On parse
// failure, refetch raw and escape stray ampersands before retrying.
async function fetchAndParse(url: string) {
  try {
    return await parser.parseURL(url);
  } catch (err) {
    let xml = await fetchRaw(url);
    xml = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    return await parser.parseString(xml);
  }
}

async function scrapeFeed(config: FeedConfig): Promise<RawCandidate[]> {
  const results: RawCandidate[] = [];

  try {
    const feed = await fetchAndParse(config.url);
    for (const item of feed.items || []) {
      if (!item.title || !item.link) continue;
      const snippet = (item.contentSnippet || item.content || '').replace(/\r/g, '');
      if (!isRelevant(item.title, snippet)) continue;

      results.push({
        title: item.title,
        url: item.link,
        snippet: snippet.slice(0, 500),
        pubDate: item.pubDate || '',
        source: config.name,
      });
    }
  } catch (err) {
    console.error(`Failed to fetch RSS for ${config.name}:`, err);
  }

  return results;
}

function candidateToReviewEntry(c: RawCandidate, index: number): ReviewEntry {
  const combined = `${c.title}. ${c.snippet}`;

  return {
    review_id: `src-${Date.now()}-${index}`,
    company: normalizeCompany(c.title.split(/cuts?|lays? off|retrench|sheds?/i)[0] || c.title),
    date_announced: parseDate(c.pubDate) || new Date().toISOString().slice(0, 10),
    date_reported: parseDate(c.pubDate) || new Date().toISOString().slice(0, 10),
    // Scraped headcount is unscoped at ingestion; default to SG, re-scoped by triage.
    jobs_cut_sg: extractJobsFromText(combined),
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Other',
    source_link: c.url,
    notes: `From ${c.source} [gn:${titleFingerprint(c.title)}]`,
    status: 'rumored',
    event_id: '',
    candidate_urls: c.url,
    snippet: c.snippet.slice(0, 300),
  };
}

async function main() {
  console.log('🔍 Scraping Singapore RSS feeds for layoff coverage...\n');

  const layoffs = readCsv('layoffs.csv');
  const reviewQueue = readCsv('review-queue.csv') as ReviewEntry[];
  const rejected = readCsv('rejected.csv');

  const allCandidates: RawCandidate[] = [];

  for (const feed of FEEDS) {
    console.log(`  Feed: ${feed.name}`);
    const results = await scrapeFeed(feed);
    console.log(`    Found ${results.length} relevant articles`);
    allCandidates.push(...results);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Dedup by URL and by title fingerprint within this run (same story can appear
  // in multiple feeds, e.g. a BT piece syndicated to AsiaOne).
  const seenUrls = new Set<string>();
  const seenFingerprints = new Set<string>();
  const unique = allCandidates.filter((c) => {
    if (seenUrls.has(c.url)) return false;
    seenUrls.add(c.url);
    const fp = titleFingerprint(c.title);
    if (fp && seenFingerprints.has(fp)) return false;
    if (fp) seenFingerprints.add(fp);
    return true;
  });

  console.log(`\n  Total unique articles: ${unique.length}`);

  const newEntries: ReviewEntry[] = [];
  let dupes = 0;
  let potentialDupes = 0;

  const seenCompanyDates = new Set<string>();

  for (let i = 0; i < unique.length; i++) {
    const candidate = unique[i];
    const entry = candidateToReviewEntry(candidate, i);

    const cdKey = `${normalizeCompany(entry.company).toLowerCase()}||${entry.date_announced}`;
    if (seenCompanyDates.has(cdKey)) {
      dupes++;
      continue;
    }

    const result = isDuplicate(entry, layoffs, reviewQueue as ReviewEntry[], rejected);

    if (result === 'new') {
      newEntries.push(entry);
      seenCompanyDates.add(cdKey);
    } else if (result === 'duplicate') {
      dupes++;
    } else {
      potentialDupes++;
      newEntries.push(entry);
      seenCompanyDates.add(cdKey);
      entry.notes = (entry.notes ? entry.notes + ' | ' : '') + 'POTENTIAL DUPLICATE - verify';
    }
  }

  if (newEntries.length > 0) {
    appendCsv('review-queue.csv', newEntries as any);
    console.log(`  ✅ Added ${newEntries.length} entries to review queue`);
  } else {
    console.log('  No new entries to add');
  }

  console.log(`  📊 ${dupes} duplicates skipped, ${potentialDupes} potential duplicates flagged`);
  console.log(`SCRAPE_RESULT:source=rss_feeds,new_entries=${newEntries.length},duplicates=${dupes},potential_dupes=${potentialDupes}`);
  console.log('\nDone. Run `npm run review` to process the queue.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
