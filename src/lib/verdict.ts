// Shared schema + parsing for LLM classification verdicts.
// Single source of truth for the label set, used by both scripts/llm-triage.ts
// (production triage) and scripts/llm-evals.ts (benchmark).
//
// We validate client-side with Zod rather than relying on server-side strict
// structured outputs (response_format: json_schema): the provider chain spans
// DeepSeek / MiMo / OpenRouter, and strict-schema support is uneven across them.
// JSON mode + Zod validation is the lowest common denominator that guarantees the
// label contract regardless of which provider answered.
import { z } from 'zod';
import { LayoffEntry, INDUSTRIES } from './types';

export const VERDICTS = ['confirmed', 'rumored', 'rejected', 'needs_review'] as const;
export const CONFIDENCES = ['high', 'medium', 'low'] as const;

export type Verdict = (typeof VERDICTS)[number];
export type Confidence = (typeof CONFIDENCES)[number];

// The `verdict` label is the contract and is enforced strictly — a missing or
// out-of-enum verdict fails validation. The soft metadata fields are coerced to a
// safe default (`.catch(...)`) instead of failing the whole object, because a model
// that nails the verdict but returns an off-list industry (e.g. "Travel") or omits
// confidence should still yield a usable verdict, not be thrown away.
export const VerdictSchema = z.object({
  verdict: z.enum(VERDICTS),
  confidence: z.enum(CONFIDENCES).catch('low'),
  company: z.string().catch(''),
  industry: z.enum(INDUSTRIES).catch('Other'),
  date_announced: z.string().catch(''),
  jobs_cut: z.number().nullable().catch(null),
  pct_workforce: z.number().nullable().catch(null),
  notes: z.string().catch(''),
  // Models emit `rejection_reason: null` on accept verdicts (not just omit it), so
  // allow null and absent as well as a string — otherwise every confirmed/rumored
  // response fails validation.
  rejection_reason: z.string().nullish(),
});

export type LLMVerdict = z.infer<typeof VerdictSchema>;

// Validate a raw response against the schema. Returns the verdict when it carries a
// valid `verdict` label (soft fields coerced), or null when the JSON is malformed or
// the verdict is missing/out-of-enum — so callers can fall through to the next
// provider instead of emitting an `undefined` verdict.
export function parseVerdict(raw: string): LLMVerdict | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = VerdictSchema.safeParse(json);
  return result.success ? result.data : null;
}

// Lenient parse for production triage: never throws on a malformed field, instead
// coercing each one to a safe default (unknown verdict → needs_review, bad industry
// → Other, missing scraped numbers → the entry's existing values). Throws only when
// `raw` is not valid JSON at all, so the caller can fall through to the next provider.
export function coerceVerdict(raw: string, entry: LayoffEntry): LLMVerdict {
  const p = JSON.parse(raw) as Partial<LLMVerdict>;
  return {
    verdict: (VERDICTS as readonly string[]).includes(p.verdict as string)
      ? (p.verdict as Verdict)
      : 'needs_review',
    confidence: (CONFIDENCES as readonly string[]).includes(p.confidence as string)
      ? (p.confidence as Confidence)
      : 'low',
    company: p.company || entry.company,
    industry: (INDUSTRIES as readonly string[]).includes(p.industry as string)
      ? (p.industry as (typeof INDUSTRIES)[number])
      : 'Other',
    date_announced: /^\d{4}-\d{2}-\d{2}$/.test(p.date_announced || '')
      ? p.date_announced!
      : entry.date_announced,
    jobs_cut: typeof p.jobs_cut === 'number' ? p.jobs_cut : entry.jobs_cut,
    pct_workforce: typeof p.pct_workforce === 'number' ? p.pct_workforce : entry.pct_workforce,
    notes: typeof p.notes === 'string' && p.notes ? p.notes : '',
    rejection_reason: p.rejection_reason,
  };
}
