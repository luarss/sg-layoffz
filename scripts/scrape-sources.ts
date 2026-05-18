import Parser from 'rss-parser';
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

async function scrapeFeed(config: FeedConfig): Promise<RawCandidate[]> {
  const results: RawCandidate[] = [];

  try {
    const feed = await parser.parseURL(config.url);
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
    jobs_cut: extractJobsFromText(combined),
    pct_workforce: null,
    industry: 'Other',
    source_link: c.url,
    notes: `From ${c.source} [gn:${titleFingerprint(c.title)}]`,
    status: 'rumored',
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

main().catch(console.error);
