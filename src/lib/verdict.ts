// Shared schema + parsing for LLM classification verdicts.
// Single source of truth for the label set, used by both scripts/llm-triage.ts
// (production triage) and scripts/llm-evals.ts (benchmark).
//
// We validate client-side with Zod rather than relying on server-side strict
// structured outputs (response_format: json_schema): the provider chain spans
// NVIDIA / Z.AI / DeepSeek / MiMo / OpenRouter, and strict-schema support is uneven across them.
// JSON mode + Zod validation is the lowest common denominator that guarantees the
// label contract regardless of which provider answered.
import { z } from 'zod';
import { INDUSTRIES } from './types';

export const VERDICTS = ['confirmed', 'rumored', 'rejected', 'needs_review'] as const;
export const CONFIDENCES = ['high', 'medium', 'low'] as const;
// Geographic scope of the jobs_cut figure, used by the golden eval to catch
// global headcounts being scoped to Singapore. Triage parses it but does not store it.
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
  // Event id the model copied from the hint list; scripts/llm-prompt.ts narrows this
  // to a hinted id or null and the pipeline mints new ids itself.
  event_id: z.string().catch(''),
  notes: z.string().catch(''),
  // Models emit `rejection_reason: null` on accept verdicts (not just omit it), so
  // allow null and absent as well as a string — otherwise every confirmed/rumored
  // response fails validation.
  rejection_reason: z.string().nullish(),
  // Optional; an off-list value coerces to null so a stray string never fails the verdict.
  headcount_scope: z.enum(SCOPES).nullish().catch(null),
});

export type LLMVerdict = z.infer<typeof VerdictSchema>;
