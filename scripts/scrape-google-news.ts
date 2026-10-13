import { searchGoogleNews, SearchHit } from './search';
import { dedupeHits, hitToReviewEntry, ingestCandidates } from './scrape-common';
import { sleep } from '../src/lib/async';

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

async function main() {
  console.log('🔍 Scraping Google News for Singapore layoff coverage...\n');

  const allCandidates: SearchHit[] = [];

  for (const query of QUERIES) {
    console.log(`  Query: "${query}"`);
    const results = await searchGoogleNews(query);
    console.log(`    Found ${results.length} articles`);
    allCandidates.push(...results);
    // Small delay between queries to avoid rate limiting
    await sleep(1000);
  }

  const unique = dedupeHits(allCandidates);
  console.log(`\n  Total unique articles: ${unique.length}`);

  const entries = unique.map((hit, i) => hitToReviewEntry(hit, i));
  ingestCandidates('google_news', entries);
  console.log('\nDone. Run `npm run review` to process the queue.');
}

main().catch(console.error);
