# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Journalists and analysts covering the Singapore job market. They need a sourced, filterable record of layoff and retrenchment events they can cite, cross-check, and compare against official MOM figures. Job seekers, employees, and the general public also read the site, but design decisions favour the journalist/analyst job.

## Product Purpose

sg-layoffz tracks publicly reported layoff and retrenchment events at companies with a presence in Singapore. It provides a sortable, filterable view of job cuts, with each event's date, Singapore headcount, industry, status, and source. Success means a journalist or analyst can find, verify, and cite an event or trend in seconds, and trusts the numbers because they can see where each one came from and how complete the dataset is.

## Positioning

- **Singapore-only, Singapore headcount.** Counts Singapore jobs cut, separate from global totals, rather than mirroring global trackers such as layoffs.fyi.
- **Benchmarked against MOM.** Each quarter's tracker totals are compared with the Ministry of Manpower's official retrenchment figures, so readers see how much of the official picture public reporting captures.
- **Automated and reviewed pipeline.** A daily scrape feeds LLM triage and manual review. Each entry is marked confirmed or rumored, and rumors are rechecked weekly.
- **Sourced and archived.** Every entry links a source, and sources are archived on the Wayback Machine.

## Operating Context

- Data lives in `data/layoffs.csv` (published entries), with `data/rejected.csv`, `data/review-queue.csv` and related files supporting the pipeline. `data/mom-benchmark.csv` holds the official quarterly MOM figures with per-quarter source links.
- GitHub Actions run the daily scrape (`scheduled-scrape.yml`), the weekly rumor recheck, and the weekly Wayback archive. Review results land as dated `review:` commits.
- Pages: home (headline totals, monthly and industry charts, MOM coverage comparison, entries table with search and filters) and About (methodology, limitations, official data, disclaimer).

## Capabilities and Constraints

- Next.js with `output: 'export'`: a static site with all data baked in at build time and no backend. This is how it is built today, not a stated requirement.
- Status vocabulary: **confirmed** (reported by at least one credible news source), **rumored** (reported but not independently verified), and **reference** (official MOM statistics for context).
- Events can have follow-up entries grouped under one `event_id`. Headcount is often undisclosed, and those events are counted separately rather than as zero.
- Coverage is limited to publicly reported layoffs. Small or unreported retrenchments, attrition, and contract non-renewals are generally not captured, and the copy must keep saying so.
- Must keep the disclaimer that the data comes from public news reports and the site is not affiliated with any government agency.

## Brand Commitments

- Name: **sg-layoffz**. Full title: **Singapore Layoff Tracker**.
- Tone: neutral and non-sensational. Layoffs affect real people, so the site never uses alarmist, celebratory, or gamified framing. Numbers are stated plainly, with their caveats.
- Attribution: built by luarss (github.com/luarss).

## Evidence on Hand

- The real dataset in `data/layoffs.csv`, with a source link for each event.
- Official MOM quarterly retrenchment figures in `data/mom-benchmark.csv`.
- No testimonials, press coverage, user counts, or endorsements exist. Future work must not invent any.

## Product Principles

1. **Every number is traceable.** A figure shown anywhere should lead back to its source entry or the official source it came from.
2. **Show completeness honestly.** Coverage limits, undisclosed headcounts, and rumored status stay visible next to the numbers they qualify, not hidden in fine print.
3. **Find, verify, cite, fast.** Searching, filtering, and sorting the entries table is the main task. Summaries support it rather than compete with it.
4. **Plain and respectful.** State the facts plainly, without spectacle.

## Accessibility & Inclusion

Target WCAG 2.2 AA: text contrast, keyboard operation of the table, filters, and expand controls, and charts that do not rely on colour alone to convey meaning.
