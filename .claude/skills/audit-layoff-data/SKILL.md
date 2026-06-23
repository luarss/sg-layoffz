---
name: audit-layoff-data
description: Audit the sg-layoffz layoff datasets (data/layoffs.csv, data/rejected.csv) for duplicates, double-counts, and row-corruption introduced by the daily scrape/triage pipeline — and check that the eval/CI safety nets would actually catch them. Use this whenever the user asks to "evaluate the recent entries", "check for dupes", "review the latest review commit", "are the eval suites good enough", or otherwise wants a sanity pass over the committed data after a scheduled scrape. Trigger it even when the user only says "check the data" or "any dupes?" without naming files — in this repo that means the layoffs datasets.
---

# Audit Layoff Data

The data in this repo is appended automatically by a daily GitHub Action
(`scheduled-scrape.yml`): scrape → LLM triage → dedup → validate → auto-commit. The
commits land directly on `main` with no human in the loop, so the job of this skill is
to be the human-equivalent review: find what the automation got wrong before (or after)
it ships, and confirm the guardrails would stop a repeat.

Two failure modes have actually occurred and are the priority on every audit:

1. **Row gluing.** Append helpers wrote `csv + '\n'` without guaranteeing the *existing*
   file already ended in a newline. When it didn't, the new first field fused onto the
   previous row's last field — e.g. B For Bagel's status `rumored` + the next company
   `Kee Wah Bakery` became `rumoredKee Wah Bakery`, silently destroying both rows (and a
   confirmed event vanished entirely). This is the highest-severity bug because data is
   *lost*, not just mislabeled.
2. **Duplicates / double-counts.** The same event gets scraped from multiple outlets and
   counted twice — either exact `company+date` repeats, or the same company a few days
   apart (two articles about one layoff round).

## Workflow

Work top to bottom. Don't stop at "tests pass" — the unit tests run on synthetic
fixtures and do **not** read the real CSVs, so they can be green while the data is
corrupt. Read the actual data.

### 1. See what recently changed

```bash
git log --oneline -8
git show <latest-review-commit> -- data/layoffs.csv
```

Read the diff with suspicion. A status field that isn't exactly `rumored` / `confirmed`
/ `reference`, or a value that runs straight into a capitalized company name with no
comma (`rumoredKee Wah Bakery`), is row gluing — flag it immediately.

### 2. Run the scan script

```bash
npx tsx .claude/skills/audit-layoff-data/scripts/scan.ts
```

It reports malformed rows (field-count != 8 → row gluing) across both CSVs, exact
`company+date` duplicates, and same-company clusters worth a manual double-count look.
Non-zero exit means a glued row exists. This bundles the checks so you don't re-derive
them each time.

### 3. Run the repo's own gates

```bash
npm run validate    # hard errors (bad status/date/missing fields) + integrity warnings
npm test            # vitest: unit logic + the committed-data golden gate
```

`validate` **errors** must be zero. **Warnings** (possible double-counts, unarchived
sources, vague company, contradictory verdicts) are advisories — triage them, don't
treat them as blockers. The near-date confirmed pairs validate flags are the real
double-count candidates; decide per pair whether it's two genuine rounds or one event
counted twice, and consolidate if it's the latter.

### 4. Repair corruption directly

For a glued row, split it back into its constituent rows. Recover the lost row's fields
from `data/llm-triage-summary.json` (search the company name) — it holds the verdict,
source, and notes the triage produced. If a field like the announcement date isn't
recorded there, verify it (e.g. a quick web search for the real closure/announcement
date) rather than fabricating one; `validate` requires `YYYY-MM-DD`. Prefer the most
reputable source URL available over a low-quality scraped mirror.

After editing, re-run step 2 and step 3 to confirm clean.

### 5. Check the safety nets, not just the data

A corruption that shipped means a guardrail failed. Inspect:

- **`.github/workflows/scheduled-scrape.yml`** — the validate step must NOT be
  `continue-on-error: true`, or it flags problems and commits anyway. The auto-commit
  step should be gated on validate succeeding.
- **`.github/workflows/test.yml`** — its `paths:` filter must include `data/**`, else
  data-only commits never run tests or validate on push. It should also run
  `npm run validate`.
- **Append helpers** — `appendCsv` (`src/lib/csv.ts`) and `appendRows`
  (`scripts/triage.ts`) must call `ensureTrailingNewline` before appending. If a new
  append path is added, it needs the same guard.
- **Golden-data test** — `tests/data-integrity.test.ts` asserts the real CSVs have zero
  validation errors and uniform field counts. This is the gate that catches what
  fixture-based unit tests miss; keep it.

## Reporting

Summarize for the user in this shape:

```
## Dupes
- exact company+date dupes: <none | list>
- corruption found: <none | row N: description, what was lost>
- double-count candidates: <table of company / dates / verdict>

## Eval-suite gaps
- <each guardrail that failed or is missing, with file:line and the fix>
```

Be concrete with `file:line` references and state plainly whether you fixed something or
are only flagging it. If tests or validate still show errors after a repair, say so with
the output — don't claim clean until step 2 and step 3 both pass.
