import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  ageInDays,
  selectStaleRumors,
  parseRecheckVerdict,
  classifyRumor,
  buildResultRow,
} from '../scripts/rumor-recheck';
import { applyResults, RecheckResult } from '../scripts/apply-rumor-results';
import type { LayoffEntry } from '../src/lib/types';
import type { CsvRow } from '../src/lib/csv';

const NOW = new Date('2026-07-24');

function rumor(overrides: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'Acme',
    date_announced: '2026-06-01',
    date_reported: '2026-06-01',
    jobs_cut_sg: null,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Tech',
    source_link: 'https://example.com/original',
    notes: 'reported plans to cut staff',
    status: 'rumored',
    event_id: 'acme-2026-06',
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('defaults to 30 days and not --all', () => {
    expect(parseArgs([])).toEqual({ days: 30, all: false });
  });
  it('parses --days N and --days=N', () => {
    expect(parseArgs(['--days', '14'])).toEqual({ days: 14, all: false });
    expect(parseArgs(['--days=7'])).toEqual({ days: 7, all: false });
  });
  it('parses --all', () => {
    expect(parseArgs(['--all'])).toEqual({ days: 30, all: true });
  });
});

describe('ageInDays / selectStaleRumors', () => {
  it('computes whole-day age', () => {
    expect(ageInDays('2026-06-24', NOW)).toBe(30);
  });

  it('selects only rumored rows older than the threshold', () => {
    const rows: LayoffEntry[] = [
      rumor({ company: 'Old', date_announced: '2026-05-01' }), // 84d
      rumor({ company: 'Fresh', date_announced: '2026-07-20' }), // 4d
      rumor({ company: 'Confirmed', date_announced: '2026-01-01', status: 'confirmed' }),
    ];
    const stale = selectStaleRumors(rows, { days: 30, all: false }, NOW);
    expect(stale.map((r) => r.company)).toEqual(['Old']);
  });

  it('--all selects every rumored row regardless of age', () => {
    const rows: LayoffEntry[] = [
      rumor({ company: 'Old', date_announced: '2026-05-01' }),
      rumor({ company: 'Fresh', date_announced: '2026-07-20' }),
      rumor({ company: 'Confirmed', status: 'confirmed' }),
    ];
    const stale = selectStaleRumors(rows, { days: 30, all: true }, NOW);
    expect(stale.map((r) => r.company)).toEqual(['Old', 'Fresh']);
  });
});

describe('parseRecheckVerdict', () => {
  it('parses a valid confirmed verdict', () => {
    const v = parseRecheckVerdict(
      JSON.stringify({ new_status: 'confirmed', evidence_url: 'https://x', headcount: 100, note: 'ok' })
    );
    expect(v).toEqual({ new_status: 'confirmed', evidence_url: 'https://x', headcount: 100, note: 'ok' });
  });
  it('returns null on out-of-enum status', () => {
    expect(parseRecheckVerdict(JSON.stringify({ new_status: 'maybe' }))).toBeNull();
  });
  it('returns null on malformed JSON', () => {
    expect(parseRecheckVerdict('not json')).toBeNull();
  });
  it('coerces bad soft fields to safe defaults', () => {
    const v = parseRecheckVerdict(JSON.stringify({ new_status: 'expired', headcount: 'lots' }));
    expect(v).toEqual({ new_status: 'expired', evidence_url: '', headcount: null, note: '' });
  });
});

describe('classifyRumor (mocked LLM client)', () => {
  // Fake OpenAI-compatible client: records the call and returns canned JSON.
  function fakeClient(responseContent: string) {
    const calls: any[] = [];
    return {
      calls,
      chat: {
        completions: {
          create: async (args: any) => {
            calls.push(args);
            return { choices: [{ message: { content: responseContent } }] };
          },
        },
      },
    } as any;
  }

  it('sends the prompt and parses the verdict without touching the network', async () => {
    const client = fakeClient(
      JSON.stringify({ new_status: 'confirmed', evidence_url: 'https://news/confirm', headcount: 50, note: 'company confirmed' })
    );
    const verdict = await classifyRumor(client, 'test-model', rumor(), [
      { title: 'Acme confirms cuts', url: 'https://news/confirm', snippet: 'Acme said...', publishedDate: '2026-07-10', source: 'News' },
    ]);
    expect(verdict).toEqual({
      new_status: 'confirmed',
      evidence_url: 'https://news/confirm',
      headcount: 50,
      note: 'company confirmed',
    });
    // The rumor + evidence were actually passed to the model.
    const userMsg = client.calls[0].messages[1].content as string;
    expect(userMsg).toContain('Acme');
    expect(userMsg).toContain('https://news/confirm');
  });

  it('returns null when the model emits an invalid verdict (caller falls through)', async () => {
    const client = fakeClient(JSON.stringify({ new_status: 'nonsense' }));
    expect(await classifyRumor(client, 'm', rumor(), [])).toBeNull();
  });
});

describe('buildResultRow', () => {
  it('flattens a confirmed verdict with headcount into the note', () => {
    const row = buildResultRow(
      rumor({ company: 'Acme', date_announced: '2026-06-01' }),
      { new_status: 'confirmed', evidence_url: 'https://x', headcount: 120, note: 'confirmed by company' },
      '2026-07-24'
    );
    expect(row).toEqual({
      company: 'Acme',
      date_announced: '2026-06-01',
      current_status: 'rumored',
      new_status: 'confirmed',
      evidence_url: 'https://x',
      evidence_note: 'confirmed by company (~120 Singapore jobs)',
      checked_at: '2026-07-24',
    });
  });
});

describe('applyResults — patches layoffs rows defensively', () => {
  // Rows carry an EXTRA column ("region") the current schema doesn't know about, to
  // prove column additions survive the patch (the CSV schema is extended elsewhere).
  function baseRows(): CsvRow[] {
    return [
      { company: 'Acme', date_announced: '2026-06-01', status: 'rumored', notes: 'planned cuts', region: 'SG' },
      { company: 'Globex', date_announced: '2026-05-01', status: 'rumored', notes: 'rumored move', region: 'SG' },
      { company: 'Initech', date_announced: '2026-04-01', status: 'rumored', notes: 'still talk', region: 'SG' },
    ];
  }

  it('changes only status + appends evidence to notes, preserving unknown columns', () => {
    const results: RecheckResult[] = [
      { company: 'Acme', date_announced: '2026-06-01', new_status: 'confirmed', evidence_url: 'https://confirm' },
    ];
    const { rows, patched, unmatched } = applyResults(baseRows(), results);
    const acme = rows.find((r) => r.company === 'Acme')!;
    expect(patched).toBe(1);
    expect(unmatched).toHaveLength(0);
    expect(acme.status).toBe('confirmed');
    expect(acme.notes).toBe('planned cuts | Evidence: https://confirm');
    expect(acme.region).toBe('SG'); // extra column untouched
  });

  it('is case-insensitive on company and exact on date', () => {
    const results: RecheckResult[] = [
      { company: 'globex', date_announced: '2026-05-01', new_status: 'denied', evidence_url: 'https://deny' },
    ];
    const { rows, patched } = applyResults(baseRows(), results);
    expect(patched).toBe(1);
    expect(rows.find((r) => r.company === 'Globex')!.status).toBe('denied');
  });

  it('treats still-rumored as a no-op (skipped)', () => {
    const results: RecheckResult[] = [
      { company: 'Initech', date_announced: '2026-04-01', new_status: 'still-rumored', evidence_url: 'https://x' },
    ];
    const { rows, patched, skipped } = applyResults(baseRows(), results);
    expect(patched).toBe(0);
    expect(skipped).toBe(1);
    const initech = rows.find((r) => r.company === 'Initech')!;
    expect(initech.status).toBe('rumored');
    expect(initech.notes).toBe('still talk');
  });

  it('reports unmatched results without throwing', () => {
    const results: RecheckResult[] = [
      { company: 'Nonexistent', date_announced: '2020-01-01', new_status: 'expired', evidence_url: '' },
    ];
    const { patched, unmatched } = applyResults(baseRows(), results);
    expect(patched).toBe(0);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].company).toBe('Nonexistent');
  });

  it('does not duplicate an evidence URL already present in notes', () => {
    const rows: CsvRow[] = [
      { company: 'Acme', date_announced: '2026-06-01', status: 'rumored', notes: 'see https://confirm already' },
    ];
    const results: RecheckResult[] = [
      { company: 'Acme', date_announced: '2026-06-01', new_status: 'confirmed', evidence_url: 'https://confirm' },
    ];
    const { rows: out } = applyResults(rows, results);
    expect(out[0].notes).toBe('see https://confirm already');
  });
});
