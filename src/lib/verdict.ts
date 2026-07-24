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
// Geographic scope of the jobs_cut figure. Used by the golden eval to catch
// global/worldwide headcounts being scoped to Singapore (the totalJobsCut
// inflation failure). Optional in the schema: the production triage prompt does
// not ask for it, so live responses simply omit it.
export const SCOPES = ['singapore', 'partial', 'global', 'unknown'] as const;

export type Verdict = (typeof VERDICTS)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Scope = (typeof SCOPES)[number];

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
  // Event date (when it happened / was announced by the company) vs report date
  // (article publication date). Both coerce to '' so a missing field never fails.
  date_announced: z.string().catch(''),
  date_reported: z.string().catch(''),
  // Singapore vs global headcount, explicitly separated. A worldwide/foreign figure
  // MUST go in jobs_cut_global (or null), never jobs_cut_sg.
  jobs_cut_sg: z.number().nullable().catch(null),
  jobs_cut_global: z.number().nullable().catch(null),
  pct_workforce: z.number().nullable().catch(null),
  // Kebab-case slug for the underlying event; the model reuses an existing entry's
  // event_id when the story matches, else proposes a new one.
  event_id: z.string().catch(''),
  notes: z.string().catch(''),
  // Models emit `rejection_reason: null` on accept verdicts (not just omit it), so
  // allow null and absent as well as a string — otherwise every confirmed/rumored
  // response fails validation.
  rejection_reason: z.string().nullish(),
  // Optional: only the golden-eval prompt requests it. An off-list value coerces to
  // unknown so a stray string never fails the whole verdict.
  headcount_scope: z.enum(SCOPES).nullish().catch(null),
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
    date_reported: /^\d{4}-\d{2}-\d{2}$/.test(p.date_reported || '')
      ? p.date_reported!
      : entry.date_reported,
    jobs_cut_sg: typeof p.jobs_cut_sg === 'number' ? p.jobs_cut_sg : entry.jobs_cut_sg,
    jobs_cut_global:
      typeof p.jobs_cut_global === 'number' ? p.jobs_cut_global : entry.jobs_cut_global,
    pct_workforce: typeof p.pct_workforce === 'number' ? p.pct_workforce : entry.pct_workforce,
    event_id: typeof p.event_id === 'string' && p.event_id ? p.event_id : entry.event_id,
    notes: typeof p.notes === 'string' && p.notes ? p.notes : '',
    rejection_reason: p.rejection_reason,
  };
}
