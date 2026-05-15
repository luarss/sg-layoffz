import * as cheerio from 'cheerio';
import { readCsv, appendCsv } from '../src/lib/csv';
import { ReviewEntry } from '../src/lib/types';
import { normalizeCompany, parseDate, extractJobsFromText } from './normalize';
import { isDuplicate } from './deduplicate';

interface SourceConfig {
  name: string;
  baseUrl: string;
  searchPath: string;
  articleSelector: string;
  titleSelector: string;
  linkSelector: string;
  snippetSelector?: string;
  dateSelector?: string;
}

const SOURCES: SourceConfig[] = [
  {
    name: 'Channel NewsAsia',
    baseUrl: 'https://www.channelnewsasia.com',
    searchPath: '/search?q=layoffs+singapore&sort=date',
    articleSelector: 'article, .list-item, .result-item',
    titleSelector: 'h3, .title, .headline',
    linkSelector: 'a',
    snippetSelector: 'p, .snippet, .description',
  },
  {
    name: 'Vulcan Post',
    baseUrl: 'https://vulcanpost.com',
    searchPath: '/?s=layoffs+singapore',
    articleSelector: 'article, .post-item',
    titleSelector: 'h2, .entry-title',
    linkSelector: 'a',
    snippetSelector: '.entry-summary, .excerpt',
  },
  {
    name: 'Tech in Asia',
    baseUrl: 'https://www.techinasia.com',
    searchPath: '/search?query=singapore+layoffs',
    articleSelector: '.search-result, article',
    titleSelector: 'h2, .title',
    linkSelector: 'a',
    snippetSelector: '.excerpt, .summary',
  },
];

interface RawCandidate {
  title: string;
  url: string;
  snippet: string;
  pubDate: string;
  source: string;
}

async function scrapeSource(config: SourceConfig): Promise<RawCandidate[]> {
  const results: RawCandidate[] = [];
  const url = `${config.baseUrl}${config.searchPath}`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sg-layoffz/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    $(config.articleSelector).each((_, el) => {
      const $el = $(el);
      const title = $el.find(config.titleSelector).first().text().trim();
      const linkEl = $el.find(config.linkSelector).first();
      let href = linkEl.attr('href') || '';
      const snippet = config.snippetSelector
        ? $el.find(config.snippetSelector).first().text().trim()
        : '';
      const pubDate = config.dateSelector
        ? $el.find(config.dateSelector).first().text().trim()
        : '';

      if (!title || !href) return;

      // Resolve relative URLs
      if (href.startsWith('/')) {
        href = config.baseUrl + href;
      }

      // Only include results that mention Singapore layoffs/redundancies
      const combined = `${title} ${snippet}`.toLowerCase();
      const relevant =
        combined.includes('singapore') &&
        (combined.includes('layoff') ||
          combined.includes('laid off') ||
          combined.includes('job cut') ||
          combined.includes('retrench') ||
          combined.includes('redundanc') ||
          combined.includes('restructur') ||
          combined.includes('downsiz') ||
          combined.includes('cut') ||
          combined.includes('slash'));

      if (!relevant) return;

      results.push({
        title,
        url: href,
        snippet: snippet.slice(0, 500),
        pubDate,
        source: config.name,
      });
    });
  } catch (err) {
    console.error(`Failed to scrape ${config.name}:`, err);
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
    hq_location: 'Singapore',
    industry: 'Other',
    source_link: c.url,
    notes: `From ${c.source}`,
    status: 'rumored',
    candidate_urls: c.url,
    snippet: c.snippet.slice(0, 300),
  };
}

async function main() {
  console.log('🔍 Scraping per-source news sites for Singapore layoff coverage...\n');

  const layoffs = readCsv('layoffs.csv');
  const reviewQueue = readCsv('review-queue.csv') as ReviewEntry[];

  const allCandidates: RawCandidate[] = [];

  for (const source of SOURCES) {
    console.log(`  Source: ${source.name}`);
    const results = await scrapeSource(source);
    console.log(`    Found ${results.length} relevant articles`);
    allCandidates.push(...results);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Deduplicate by URL
  const seenUrls = new Set<string>();
  const unique = allCandidates.filter((c) => {
    if (seenUrls.has(c.url)) return false;
    seenUrls.add(c.url);
    return true;
  });

  console.log(`\n  Total unique articles: ${unique.length}`);

  const newEntries: ReviewEntry[] = [];
  let dupes = 0;
  let potentialDupes = 0;

  for (let i = 0; i < unique.length; i++) {
    const candidate = unique[i];
    const entry = candidateToReviewEntry(candidate, i);
    const result = isDuplicate(entry, layoffs, reviewQueue as ReviewEntry[]);

    if (result === 'new') {
      newEntries.push(entry);
    } else if (result === 'duplicate') {
      dupes++;
    } else {
      potentialDupes++;
      newEntries.push(entry);
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
  console.log('\nDone. Run `npm run review` to process the queue.');
}

main().catch(console.error);
