import { describe, it, expect } from 'vitest';
import { readCsv } from '../src/lib/csv';
import { companyKey } from '../scripts/normalize';
import allowedNeighbours from './fixtures/allowed-company-key-neighbours.json';

interface NeighbourPair {
  a: string;
  b: string;
  why: string;
}

const MIN_KEY_LENGTH = 4;

function distinctSortedKeys(): string[] {
  const keys = new Set(readCsv('layoffs.csv').map((row) => companyKey(String(row.company ?? ''))));
  return [...keys].sort();
}

function isPrefixNeighbour(shorter: string, longer: string): boolean {
  if (shorter.length < MIN_KEY_LENGTH || longer.length < MIN_KEY_LENGTH) return false;
  return longer.startsWith(shorter + ' ');
}

function prefixNeighbours(keys: string[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    if (isPrefixNeighbour(keys[i], keys[i + 1])) pairs.push(`${keys[i]} | ${keys[i + 1]}`);
  }
  return pairs;
}

describe('companyKey splits in data/layoffs.csv', () => {
  it('has no unexplained prefix-neighbour keys', () => {
    const allowed = new Set((allowedNeighbours as NeighbourPair[]).map(({ a, b }) => `${a} | ${b}`));
    const unexplained = prefixNeighbours(distinctSortedKeys()).filter((pair) => !allowed.has(pair));
    expect(unexplained).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    for (const entry of allowedNeighbours as NeighbourPair[]) {
      expect(entry.why.trim().length).toBeGreaterThan(0);
    }
  });
});
