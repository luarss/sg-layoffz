import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  formatEventHints,
  hintedEventIds,
  parseModelVerdict,
  pickHintedEventId,
  withEntryDefaults,
  type EventHints,
} from '../scripts/llm-prompt';
import { callJsonWithChain, type ChatProvider } from '../scripts/llm-provider';
import type { LayoffEntry } from '../src/lib/types';

function entry(overrides: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'H&M',
    date_announced: '2026-07-15',
    date_reported: '2026-07-16',
    jobs_cut_sg: null,
    jobs_cut_global: 120,
    pct_workforce: null,
    industry: 'Retail',
    source_link: 'https://example.com/hm',
    notes: 'H&M closes Southeast Asia HQ in Singapore',
    status: 'confirmed',
    event_id: '',
    ...overrides,
  };
}

function verdictJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'confirmed',
    confidence: 'high',
    company: 'H&M',
    industry: 'Retail',
    date_announced: '2026-07-15',
    date_reported: '2026-07-16',
    jobs_cut_sg: 40,
    jobs_cut_global: null,
    pct_workforce: null,
    headcount_scope: 'singapore',
    event_id: 'h-m-2026-07',
    notes: 'H&M confirmed the closure.',
    rejection_reason: null,
    ...overrides,
  });
}

const HINTS: EventHints = {
  primary: { event_id: 'h-m-2026-07', company: 'H&M', date_announced: '2026-07-10' },
  listed: [{ event_id: 'h-m-2025-03', company: 'H&M', date_announced: '2025-03-02' }],
};

describe('parseModelVerdict', () => {
  it('accepts a valid verdict whose event_id is in the hint list', () => {
    const parsed = parseModelVerdict(verdictJson(), hintedEventIds(HINTS));
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict.verdict).toBe('confirmed');
    expect(parsed!.verdict.event_id).toBe('h-m-2026-07');
    expect(parsed!.verdict.headcount_scope).toBe('singapore');
    expect(parsed!.discardedEventId).toBeNull();
  });

  it('normalises a minted descriptive slug to null and reports it as discarded', () => {
    const parsed = parseModelVerdict(
      verdictJson({ event_id: 'h-m-closes-southeast-asia-hq-2026-07' }),
      hintedEventIds(HINTS)
    );
    expect(parsed!.verdict.event_id).toBeNull();
    expect(parsed!.discardedEventId).toBe('h-m-closes-southeast-asia-hq-2026-07');
  });

  it('discards any event_id when no hints were offered', () => {
    const parsed = parseModelVerdict(verdictJson({ event_id: 'hm-2026-07' }));
    expect(parsed!.verdict.event_id).toBeNull();
    expect(parsed!.discardedEventId).toBe('hm-2026-07');
  });

  it('keeps an explicit null event_id without flagging it', () => {
    const parsed = parseModelVerdict(verdictJson({ event_id: null }), hintedEventIds(HINTS));
    expect(parsed!.verdict.event_id).toBeNull();
    expect(parsed!.discardedEventId).toBeNull();
  });

  it('rejects malformed JSON and out-of-enum verdicts', () => {
    expect(parseModelVerdict('not json')).toBeNull();
    expect(parseModelVerdict(verdictJson({ verdict: 'maybe' }))).toBeNull();
  });

  it('coerces soft fields instead of failing', () => {
    const parsed = parseModelVerdict(verdictJson({ industry: 'Travel', confidence: 'certain', headcount_scope: 'regional' }));
    expect(parsed!.verdict.industry).toBe('Other');
    expect(parsed!.verdict.confidence).toBe('low');
    expect(parsed!.verdict.headcount_scope).toBeNull();
  });
});

describe('pickHintedEventId', () => {
  it('only returns verbatim matches', () => {
    expect(pickHintedEventId('h-m-2025-03', ['h-m-2025-03'])).toBe('h-m-2025-03');
    expect(pickHintedEventId(' h-m-2025-03 ', ['h-m-2025-03'])).toBe('h-m-2025-03');
    expect(pickHintedEventId('H-M-2025-03', ['h-m-2025-03'])).toBeNull();
    expect(pickHintedEventId('', ['h-m-2025-03'])).toBeNull();
    expect(pickHintedEventId(null, [])).toBeNull();
  });
});

describe('withEntryDefaults', () => {
  it('fills missing numbers, bad dates and empty company from the scraped entry', () => {
    const parsed = parseModelVerdict(
      verdictJson({ company: '', date_announced: 'July 2026', jobs_cut_sg: null, jobs_cut_global: null })
    );
    const filled = withEntryDefaults(parsed!.verdict, entry());
    expect(filled.company).toBe('H&M');
    expect(filled.date_announced).toBe('2026-07-15');
    expect(filled.jobs_cut_global).toBe(120);
    expect(filled.jobs_cut_sg).toBeNull();
  });
});

describe('buildUserPrompt', () => {
  it('lists the scraped fields', () => {
    const prompt = buildUserPrompt(entry());
    expect(prompt).toContain('Title/Company: H&M');
    expect(prompt).toContain('Jobs cut global (scraped): 120');
    expect(prompt).toContain('Notes/snippet: H&M closes Southeast Asia HQ in Singapore');
    expect(prompt).not.toContain('Existing events');
  });

  it('appends the event hint lines', () => {
    const prompt = buildUserPrompt(entry(), formatEventHints(HINTS));
    expect(prompt).toContain('follow-up coverage of event h-m-2026-07 (H&M, 2026-07-10)');
    expect(prompt).toContain('Existing events for this company');
    expect(prompt).toContain('  - h-m-2025-03 (2025-03-02)');
  });

  it('adds nothing when there are no hints', () => {
    expect(formatEventHints({ primary: null, listed: [] })).toBe('');
    expect(buildUserPrompt(entry(), '')).toBe(buildUserPrompt(entry()));
  });
});

describe('SYSTEM_PROMPT', () => {
  it('forbids minting event ids and asks for headcount_scope', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER invent');
    expect(SYSTEM_PROMPT).toContain('return null');
    expect(SYSTEM_PROMPT).toContain('"headcount_scope"');
    expect(SYSTEM_PROMPT).toContain('## Event date vs report date');
  });
});

describe('callJsonWithChain (mocked clients)', () => {
  type FakeResponse = { content?: string; finish_reason?: string } | Error;

  function fakeProvider(name: string, responses: FakeResponse[]): ChatProvider & { calls: number } {
    const provider = {
      name,
      model: `${name}-model`,
      calls: 0,
      client: {
        chat: {
          completions: {
            create: async () => {
              const next = responses[Math.min(provider.calls, responses.length - 1)];
              provider.calls++;
              if (next instanceof Error) throw next;
              return { choices: [{ message: { content: next.content }, finish_reason: next.finish_reason }] };
            },
          },
        },
      },
    };
    return provider as unknown as ChatProvider & { calls: number };
  }

  const parse = (raw: string) => {
    const json = JSON.parse(raw);
    return json.ok ? (json as { ok: true }) : null;
  };

  it('falls through truncated and failing providers to the next one', async () => {
    const truncated = fakeProvider('first', [{ content: '{"ok":true}', finish_reason: 'length' }]);
    const broken = fakeProvider('second', [new Error('503')]);
    const working = fakeProvider('third', [{ content: '{"ok":true}' }]);
    const logged: string[] = [];
    const result = await callJsonWithChain([truncated, broken, working], {
      system: 's',
      user: 'u',
      parse,
      log: (message) => logged.push(message),
    });
    expect(result.value).toEqual({ ok: true });
    expect(result.provider).toBe('third');
    expect(result.errors).toHaveLength(2);
    expect(logged).toEqual([' [first truncated, trying next]', ' [second failed, trying next]']);
  });

  it('treats empty content as {} and reports failure when nothing parses', async () => {
    const empty = fakeProvider('only', [{ content: '' }]);
    const result = await callJsonWithChain([empty], { system: 's', user: 'u', parse, log: () => {} });
    expect(result.value).toBeNull();
    expect(result.provider).toBe('none');
    expect(result.errors[0]).toContain('raw: {}');
  });

  it('retries the same provider up to the attempts limit', async () => {
    const flaky = fakeProvider('flaky', [new Error('429'), { content: '{"ok":true}' }]);
    const result = await callJsonWithChain([flaky], { system: 's', user: 'u', parse, attempts: 2, log: () => {} });
    expect(result.value).toEqual({ ok: true });
    expect(flaky.calls).toBe(2);
  });
});
