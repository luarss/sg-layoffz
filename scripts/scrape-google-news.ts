import Parser from 'rss-parser';
import { readCsv, appendCsv } from '../src/lib/csv';
import { ReviewEntry } from '../src/lib/types';
import { normalizeCompany, parseDate, extractJobsFromText } from './normalize';
import { isDuplicate } from './deduplicate';

const parser = new Parser();

// Google News RSS is free/unlimited, so we run a broad set spanning event types
// and sectors. Bare "Singapore layoffs" returns the same top stories daily;
// sector- and event-specific terms surface the long tail we'd otherwise miss.
const QUERIES = [
  'Singapore layoffs',
  'Singapore retrenchment',
  'Singapore job cuts',
  'Singapore tech layoffs',
  'Singapore office closure jobs',
  'Singapore company restructuring redundancies',
  'Singapore hiring freeze',
  'Singapore bank job cuts',
  'Singapore manufacturing plant closure',
  'Singapore startup shuts down',
];

interface RawCandidate {
  title: string;
  url: string;
  snippet: string;
  pubDate: string;
  source: string;
}

// Google News RSS gives different opaque wrapper URLs for the same article depending
// on which query fetched it. We fingerprint the title (stripped source, first 6 words)
// and use it as a secondary dedup key within a run and as the `notes` field so
// isDuplicate can catch the same article coming in on a future run.
function titleFingerprint(title: string): string {
  return title
    .replace(/ [-–] [^-–\n]+$/, '') // strip "- Source Name" suffix
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

async function scrapeQuery(query: string): Promise<RawCandidate[]> {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-SG&gl=SG&ceid=SG:en`;
  const results: RawCandidate[] = [];
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
        pubDate: item.pubDate || '',
        source: item.source?.name || 'Google News',
      });
    }
  } catch (err) {
    console.error(`    [timing] "${query}": FAILED after ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    console.error(`Failed to fetch RSS for "${query}":`, err);
  }

  return results;
}

function candidateToReviewEntry(c: RawCandidate, index: number): ReviewEntry {
  const combined = `${c.title}. ${c.snippet}`;

  return {
    review_id: `${Date.now()}-${index}`,
    company: normalizeCompany(c.title.split(/cuts?|lays? off|retrench|sheds?/i)[0] || c.title),
    date_announced: parseDate(c.pubDate) || new Date().toISOString().slice(0, 10),
    date_reported: parseDate(c.pubDate) || new Date().toISOString().slice(0, 10),
    // Scraped headcount is unscoped at ingestion; default it to the SG column and let
    // triage / LLM re-scope it to jobs_cut_global if the source is worldwide.
    jobs_cut_sg: extractJobsFromText(combined),
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Other',
    source_link: c.url,
    notes: `[gn:${titleFingerprint(c.title)}]`,
    status: 'rumored',
    event_id: '',
    candidate_urls: c.url,
    snippet: c.snippet.slice(0, 300),
  };
}

async function main() {
  console.log('🔍 Scraping Google News for Singapore layoff coverage...\n');

  const layoffs = readCsv('layoffs.csv');
  const reviewQueue = readCsv('review-queue.csv') as ReviewEntry[];
  const rejected = readCsv('rejected.csv');

  const allCandidates: RawCandidate[] = [];

  for (const query of QUERIES) {
    console.log(`  Query: "${query}"`);
    const results = await scrapeQuery(query);
    console.log(`    Found ${results.length} articles`);
    allCandidates.push(...results);
    // Small delay between queries to avoid rate limiting
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Dedup by URL, then by title fingerprint — Google News returns different opaque
  // wrapper URLs for the same article across queries, but titles stay consistent.
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const unique = allCandidates.filter((c) => {
    if (seenUrls.has(c.url)) return false;
    seenUrls.add(c.url);
    const fp = titleFingerprint(c.title);
    if (fp && seenTitles.has(fp)) return false;
    seenTitles.add(fp);
    return true;
  });

  console.log(`\n  Total unique articles: ${unique.length}`);

  // Check against existing data
  const newEntries: ReviewEntry[] = [];
  let dupes = 0;
  let potentialDupes = 0;

  // Track company+date pairs within this run so we don't add the same article
  // twice when Google News returns slightly different titles for different
  // queries (the title-fingerprint dedup above requires exact title match).
  const seenCompanyDates = new Set<string>();

  for (let i = 0; i < unique.length; i++) {
    const candidate = unique[i];
    const entry = candidateToReviewEntry(candidate, i);

    // Within-run dedup: same derived company + same date = same article.
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
      newEntries.push(entry); // Still add, but mark in notes
      seenCompanyDates.add(cdKey);
      entry.notes = `${entry.notes} | POTENTIAL DUPLICATE - verify manually`;
    }
  }

  // Write to review queue
  if (newEntries.length > 0) {
    appendCsv('review-queue.csv', newEntries as any);
    console.log(`  ✅ Added ${newEntries.length} entries to review queue`);
  } else {
    console.log('  No new entries to add');
  }

  console.log(`  📊 ${dupes} duplicates skipped, ${potentialDupes} potential duplicates flagged`);
  console.log(`SCRAPE_RESULT:source=google_news,new_entries=${newEntries.length},duplicates=${dupes},potential_dupes=${potentialDupes}`);
  console.log('\nDone. Run `npm run review` to process the queue.');
}

main().catch(console.error);
