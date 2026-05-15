import * as readline from 'node:readline';
import { readCsv, writeCsv, appendCsv } from '../src/lib/csv';
import { LayoffEntry, ReviewEntry, INDUSTRIES } from '../src/lib/types';
import { validateCsv } from './validate';

const REVIEW_QUEUE = 'review-queue.csv';
const LAYOFFS_CSV = 'layoffs.csv';
const REJECTED_CSV = 'rejected.csv';

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function displayEntry(entry: ReviewEntry, index: number, total: number) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Entry #${index + 1} of ${total}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Company:      ${entry.company}`);
  console.log(`  Date:         ${entry.date_announced}`);
  console.log(`  Jobs cut:     ${entry.jobs_cut ?? 'Unknown'}`);
  console.log(`  % Workforce:  ${entry.pct_workforce ?? 'Unknown'}`);
  console.log(`  HQ:           ${entry.hq_location}`);
  console.log(`  Industry:     ${entry.industry}`);
  console.log(`  Source:       ${entry.source_link}`);
  console.log(`  Snippet:      ${entry.snippet?.slice(0, 200) || 'N/A'}`);
  if (entry.notes) {
    console.log(`  ⚠️  Notes:     ${entry.notes}`);
  }
  console.log(`${'─'.repeat(70)}`);
}

async function editEntry(
  rl: readline.Interface,
  entry: ReviewEntry
): Promise<ReviewEntry> {
  const updated = { ...entry };

  console.log('\nEdit fields (press Enter to keep current value):\n');

  const fields: { key: keyof ReviewEntry; label: string; validate?: (v: string) => boolean }[] = [
    { key: 'company', label: 'Company' },
    {
      key: 'date_announced',
      label: 'Date (YYY-MM-DD)',
      validate: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v),
    },
    {
      key: 'jobs_cut',
      label: 'Jobs cut',
      validate: (v: string) => v === '' || !isNaN(Number(v)),
    },
    {
      key: 'pct_workforce',
      label: '% Workforce (0-100)',
      validate: (v: string) => v === '' || (!isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 100),
    },
    { key: 'hq_location', label: 'HQ Location' },
    {
      key: 'industry',
      label: `Industry (${INDUSTRIES.join(', ')})`,
      validate: (v: string) => INDUSTRIES.includes(v as any) || v === '',
    },
    { key: 'source_link', label: 'Source URL' },
    { key: 'notes', label: 'Notes' },
    {
      key: 'status',
      label: 'Status (rumored/confirmed/reference)',
      validate: (v: string) => ['rumored', 'confirmed', 'reference'].includes(v),
    },
  ];

  for (const field of fields) {
    let current = updated[field.key];
    if (current === null || current === undefined) current = '' as any;
    const input = await prompt(rl, `  ${field.label} [${current}]: `);

    if (input.trim() === '') continue;

    if (field.validate && !field.validate(input.trim())) {
      console.log(`  ⚠️  Invalid value, keeping current: ${current}`);
      continue;
    }

    (updated as any)[field.key] = input.trim();
  }

  // Convert numeric fields
  if (updated.jobs_cut !== null && updated.jobs_cut !== undefined) {
    updated.jobs_cut = Number(updated.jobs_cut);
  }
  if (updated.pct_workforce !== null && updated.pct_workforce !== undefined) {
    updated.pct_workforce = Number(updated.pct_workforce);
  }

  return updated;
}

async function main() {
  const queue = readCsv(REVIEW_QUEUE) as ReviewEntry[];

  if (queue.length === 0) {
    console.log('📭 Review queue is empty. Run `npm run scrape` first.');
    return;
  }

  console.log(`\n📋 ${queue.length} entries in review queue\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const remaining: ReviewEntry[] = [];
  let approved = 0;
  let rejected = 0;

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    displayEntry(entry, i, queue.length);

    const action = await prompt(rl, '\n[A]pprove  [R]eject  [E]dit  [S]kip  [Q]uit: ');

    switch (action.toLowerCase()) {
      case 'a': {
        const { review_id, candidate_urls, snippet, ...layoffEntry } = entry;
        appendCsv(LAYOFFS_CSV, [layoffEntry as LayoffEntry]);
        console.log('  ✅ Approved');
        approved++;
        break;
      }
      case 'r': {
        const { review_id: _1, candidate_urls: _2, snippet: _3, ...layoffEntry } = entry;
        appendCsv(REJECTED_CSV, [layoffEntry as LayoffEntry]);
        console.log('  ❌ Rejected');
        rejected++;
        break;
      }
      case 'e': {
        const updated = await editEntry(rl, entry);
        displayEntry(updated, i, queue.length);
        const confirm = await prompt(rl, '\nApprove edited entry? [Y/n]: ');
        if (confirm.toLowerCase() !== 'n') {
          const { review_id: _4, candidate_urls: _5, snippet: _6, ...layoffEntry } = updated;
          appendCsv(LAYOFFS_CSV, [layoffEntry as LayoffEntry]);
          console.log('  ✅ Approved (edited)');
          approved++;
        } else {
          remaining.push(updated);
          console.log('  ↪️  Skipped (kept in queue)');
        }
        break;
      }
      case 's':
        remaining.push(entry);
        console.log('  ↪️  Skipped');
        break;
      case 'q':
        remaining.push(entry);
        // Add all remaining entries
        for (let j = i + 1; j < queue.length; j++) {
          remaining.push(queue[j]);
        }
        console.log(`\n  Quit. ${remaining.length} entries remaining in queue.`);
        rl.close();

        // Save remaining to queue
        writeCsv(REVIEW_QUEUE, remaining as any);

        console.log(`\n📊 Session summary: ${approved} approved, ${rejected} rejected, ${remaining.length} remaining`);
        validateCsv(LAYOFFS_CSV);
        return;
      default:
        remaining.push(entry);
        console.log('  ↪️  Unknown action, skipped');
    }
  }

  rl.close();

  // Save remaining to queue
  writeCsv(REVIEW_QUEUE, remaining as any);

  console.log(`\n📊 Session summary: ${approved} approved, ${rejected} rejected, ${remaining.length} remaining`);
  validateCsv(LAYOFFS_CSV);
}

main().catch(console.error);
