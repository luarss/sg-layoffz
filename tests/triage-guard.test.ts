import { describe, it, expect } from 'vitest';
import { analyzeDataset } from '../scripts/validate';
import { screenTriageBatch, DatasetAnalyzer, TriageCandidate } from '../scripts/triage-guard';
import type { LayoffEntry } from '../src/lib/types';

function entry(overrides: Partial<LayoffEntry> = {}): LayoffEntry {
  return {
    company: 'Bitsmedia',
    date_announced: '2026-09-24',
    date_reported: '2026-09-24',
    jobs_cut_sg: 21,
    jobs_cut_global: null,
    pct_workforce: null,
    industry: 'Tech',
    source_link: 'https://www.straitstimes.com/business/bitsmedia-lays-off-21',
    notes: 'Bitsmedia laid off 21 employees in Singapore.',
    status: 'confirmed',
    event_id: 'bitsmedia-2026-09',
    ...overrides,
  };
}

const realAnalyzer: DatasetAnalyzer = (layoffs, rejected) => {
  const analysis = analyzeDataset(layoffs, rejected, new Set());
  return [...analysis.hardIntegrityErrors, ...analysis.warnings];
};

describe('screenTriageBatch', () => {
  it('keeps every candidate when the batch adds no new warnings', () => {
    const followUp = entry({
      date_reported: '2026-10-01',
      source_link: 'https://www.asiaone.com/singapore/muslim-pro-owner-bitsmedia-lays-off-21-staff-retrenchment',
    });
    const candidates: TriageCandidate[] = [{ target: 'layoffs', row: followUp }];

    const screened = screenTriageBatch([entry()], [], candidates, realAnalyzer);

    expect(screened.accepted).toEqual([followUp]);
    expect(screened.heldBack).toEqual([]);
  });

  it('holds back a confirmed row from an unrecognised source and keeps the rest', () => {
    const digg = entry({ date_reported: '2026-10-13', source_link: 'https://digg.com/tech/9hp52169' });
    const asiaone = entry({
      date_reported: '2026-10-01',
      source_link: 'https://www.asiaone.com/singapore/muslim-pro-owner-bitsmedia-lays-off-21-staff-retrenchment',
    });
    const candidates: TriageCandidate[] = [
      { target: 'layoffs', row: digg },
      { target: 'layoffs', row: asiaone },
    ];

    const screened = screenTriageBatch([entry()], [], candidates, realAnalyzer);

    expect(screened.accepted).toEqual([asiaone]);
    expect(screened.heldBack.map((h) => h.candidate.row)).toEqual([digg]);
    expect(screened.heldBack[0].warnings.map((w) => w.type)).toEqual(['unarchived-confirmed']);
  });

  it('holds back a rejected row that contradicts a kept layoffs row', () => {
    const kept = entry();
    const rejectedCopy = entry({ notes: '[LLM rejected: not-sg] not a Singapore layoff' });
    const candidates: TriageCandidate[] = [{ target: 'rejected', row: rejectedCopy }];

    const screened = screenTriageBatch([kept], [], candidates, realAnalyzer);

    expect(screened.rejected).toEqual([]);
    expect(screened.heldBack.map((h) => h.candidate.target)).toEqual(['rejected']);
  });

  it('ignores warnings that already exist before the batch', () => {
    const preexisting = entry({ source_link: 'https://digg.com/tech/old' });
    const fresh = entry({ company: 'Acme', event_id: 'acme-2026-09', notes: 'Acme cut 10 staff.' });
    const candidates: TriageCandidate[] = [{ target: 'layoffs', row: fresh }];

    const screened = screenTriageBatch([preexisting], [], candidates, realAnalyzer);

    expect(screened.accepted).toEqual([fresh]);
    expect(screened.heldBack).toEqual([]);
  });
});
