import { describe, it, expect } from 'vitest';
import { readCsv } from '../src/lib/csv';
import { checkIntegrity, type NeighbourPair } from '../scripts/validate';
import allowedNeighbours from '../data/allowed-company-key-neighbours.json';

describe('companyKey splits in data/layoffs.csv', () => {
  it('has no unexplained prefix-neighbour keys', () => {
    const splits = checkIntegrity(readCsv('layoffs.csv'))
      .filter((warning) => warning.type === 'name-split')
      .map((warning) => warning.identity);
    expect(splits).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    for (const entry of allowedNeighbours as NeighbourPair[]) {
      expect(entry.why.trim().length).toBeGreaterThan(0);
    }
  });
});
