import { z } from 'zod';
import { LayoffEntry } from '../src/lib/types';
import { VerdictSchema } from '../src/lib/verdict';

export const SYSTEM_PROMPT = `You are an expert analyst for a Singapore layoff tracking database. Evaluate news articles about potential Singapore layoff events and classify each one.

## Classification Rules

**CONFIRMED** — all must be true:
- Officially announced or credibly reported job cuts/retrenchment
- Specific named company with Singapore operations
- Already happened or actively underway (not a future plan)

**RUMORED** — same as confirmed but:
- Planned, anticipated, or reported as likely ("plans to cut", "expected to retrench", "may lay off")

**Closures count as layoff events.** A Singapore business, store, outlet, or branch
closure that implies job losses IS a layoff event — even when the headcount is unstated
and even when it is a single outlet of a continuing chain. Classify it CONFIRMED if it has
already closed or is actively closing, RUMORED if it is an announced or future closure. Do
NOT reject a Singapore closure as "not a layoff" or as having "no Singapore nexus".

**REJECTED** — reject if ANY applies:
- Commentary, opinion, analysis, or market overview about layoffs in general
- Labour market statistics (MOM data, employment surveys, percentage reports)
- Government or parliamentary policy debate (MAS, MOM proposals, union discussions)
- Job posting or hiring announcement
- No clear Singapore nexus (foreign company, foreign office only)
- Personal anecdote or first-person story ("I got laid off…")
- Aggregator article covering many companies (not a single specific event)
- Legal case, court ruling, or severance policy debate
- Duplicate of an already well-known event
- Unnamed, anonymized, or placeholder company — the subject is a generic descriptor
  ("an art firm", "another legacy bank", "unnamed AI startup", "a pension manager")
  rather than a specific named company

**NEEDS_REVIEW** — use ONLY as a last resort, for a genuinely ambiguous article where
none of the rules above apply. Do NOT retreat to needs_review just to avoid a hard call:
- If any REJECTED rule matches, return \`rejected\`.
- If it is a Singapore closure or a credibly reported cut, decide \`confirmed\`/\`rumored\`.
- A worldwide or foreign headcount does NOT make the verdict ambiguous — still classify
  the event (accept when there is a Singapore nexus, reject when there is none) and put
  the figure in jobs_cut_global.

## Evaluation Dimensions (assess internally)
1. singapore_nexus — does this involve a Singapore entity or Singapore office of a multinational?
2. layoff_authenticity — is this a real layoff announcement (not commentary or statistics)?
3. company_identifiable — is a specific company clearly named?
4. date_extractable — is there a discernible announcement date?
5. source_credibility — is the source a credible news outlet or company press release?
6. not_commentary — not an opinion piece, explainer, or market report?
7. not_policy_debate — not a parliamentary or government policy discussion?
8. not_personal_anecdote — not a personal story?

## Allowed Industries
Tech, Finance, Manufacturing, Retail, F&B, Real Estate, Healthcare, Education, Other

## Headcount Scope — Singapore vs global
This tracker counts SINGAPORE jobs only. Split the headcount into two fields:
- "jobs_cut_sg" — number of SINGAPORE roles cut (only when the figure is specifically
  Singapore staff). Otherwise null.
- "jobs_cut_global" — the worldwide/foreign/regional figure the source gave (e.g.
  "18,000 jobs globally", "1,000 jobs in Britain", "8,000 back-office roles"). Otherwise null.
A worldwide or foreign figure MUST go in jobs_cut_global, NEVER jobs_cut_sg. If the
number is Singapore-specific, use jobs_cut_sg and leave jobs_cut_global null. If no
headcount is disclosed, both are null.

Also classify the headcount figure in "headcount_scope":
- "singapore" — the number is specifically Singapore roles
- "partial" — a regional/divisional number that includes Singapore among other markets
- "global" — a worldwide/foreign number; Singapore is not the figure's scope
- "unknown" — no headcount, or scope unclear
A worldwide or foreign figure must NOT be reported as "singapore".

## Event date vs report date
- "date_announced" — when the layoff event happened / was announced by the company.
- "date_reported" — the article's publication date (may be later; follow-up coverage).

## Event id
"event_id" links this story to an event that is ALREADY tracked. You must NEVER invent,
compose, or reformat an event_id.
- If this story is follow-up coverage of an event named in the user message (the
  "follow-up coverage of event" line or the "Existing events for this company" list),
  return that event_id copied verbatim, character for character.
- Otherwise — a genuinely new event, a separate later round of cuts, or no existing
  events listed — return null. The system assigns ids for new events itself.

## Output
Return ONLY a valid JSON object (no markdown, no extra text):
{
  "verdict": "confirmed" | "rumored" | "rejected" | "needs_review",
  "confidence": "high" | "medium" | "low",
  "company": "Company Name",
  "industry": "<one of the allowed industries>",
  "date_announced": "YYYY-MM-DD",
  "date_reported": "YYYY-MM-DD",
  "jobs_cut_sg": <integer or null>,
  "jobs_cut_global": <integer or null>,
  "pct_workforce": <number or null>,
  "headcount_scope": "singapore" | "partial" | "global" | "unknown",
  "event_id": "<an event_id copied verbatim from the user message>" | null,
  "notes": "1–2 sentence reason for your decision",
  "rejection_reason": "<commentary|statistics|policy|job-posting|not-sg|duplicate|personal|aggregator|legal|vague> (only when verdict=rejected)"
}`;

export const ModelVerdictSchema = VerdictSchema.extend({
  event_id: z.string().nullable().catch(null),
});

export type ModelVerdict = z.infer<typeof ModelVerdictSchema>;

export interface ParsedVerdict {
  verdict: ModelVerdict;
  discardedEventId: string | null;
}

export interface EventHint {
  event_id: string;
  date_announced: string;
  company: string;
}

export interface EventHints {
  primary: EventHint | null;
  listed: EventHint[];
}

export function buildUserPrompt(entry: LayoffEntry, hintsText?: string): string {
  const lines: string[] = [
    `Title/Company: ${entry.company}`,
    `Date: ${entry.date_announced}`,
    `Source URL: ${entry.source_link}`,
  ];
  if (entry.jobs_cut_sg != null) lines.push(`Jobs cut SG (scraped): ${entry.jobs_cut_sg}`);
  if (entry.jobs_cut_global != null) lines.push(`Jobs cut global (scraped): ${entry.jobs_cut_global}`);
  if (entry.pct_workforce != null) lines.push(`% workforce (scraped): ${entry.pct_workforce}`);
  if (entry.notes) lines.push(`Notes/snippet: ${entry.notes}`);
  if (hintsText) lines.push(hintsText);
  return lines.join('\n');
}

export function formatEventHints(hints: EventHints): string {
  const lines: string[] = [];
  if (hints.primary) {
    const { event_id, company, date_announced } = hints.primary;
    lines.push(
      `This appears to be follow-up coverage of event ${event_id} (${company}, ${date_announced}). ` +
      `Return that exact event_id unless the article clearly describes a separate, later round of cuts (then return null).`
    );
  }
  if (hints.listed.length > 0) {
    lines.push('Existing events for this company (return one of these event_ids verbatim if this is follow-up coverage, else null):');
    for (const hint of hints.listed) lines.push(`  - ${hint.event_id} (${hint.date_announced})`);
  }
  return lines.join('\n');
}

export function hintedEventIds(hints: EventHints): string[] {
  const ids = hints.listed.map((hint) => hint.event_id);
  return hints.primary ? [hints.primary.event_id, ...ids] : ids;
}

export function pickHintedEventId(candidate: string | null, hintedIds: readonly string[]): string | null {
  const trimmed = (candidate ?? '').trim();
  return trimmed && hintedIds.includes(trimmed) ? trimmed : null;
}

export function parseModelVerdict(raw: string, hintedIds: readonly string[] = []): ParsedVerdict | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ModelVerdictSchema.safeParse(json);
  if (!result.success) return null;

  const proposed = result.data.event_id?.trim() || null;
  const eventId = pickHintedEventId(proposed, hintedIds);
  return {
    verdict: { ...result.data, event_id: eventId },
    discardedEventId: proposed && !eventId ? proposed : null,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateOr(value: string, fallback: string): string {
  return ISO_DATE.test(value) ? value : fallback;
}

export function withEntryDefaults(verdict: ModelVerdict, entry: LayoffEntry): ModelVerdict {
  return {
    ...verdict,
    company: verdict.company || entry.company,
    date_announced: isoDateOr(verdict.date_announced, entry.date_announced),
    date_reported: isoDateOr(verdict.date_reported, entry.date_reported),
    jobs_cut_sg: verdict.jobs_cut_sg ?? entry.jobs_cut_sg,
    jobs_cut_global: verdict.jobs_cut_global ?? entry.jobs_cut_global,
    pct_workforce: verdict.pct_workforce ?? entry.pct_workforce,
  };
}
