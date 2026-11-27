import { describe, it, expect } from 'vitest';
import { isSafeHttpUrl, safeHttpUrl } from '../src/lib/safeUrl';
import { validateEntry } from '../scripts/validate';
import type { LayoffEntry } from '../src/lib/types';

describe('safeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(safeHttpUrl('https://www.straitstimes.com/a')).toBe('https://www.straitstimes.com/a');
    expect(safeHttpUrl(' http://example.com ')).toBe('http://example.com');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example',
    'not a url',
    '',
  ])('rejects %s', (value) => {
    expect(isSafeHttpUrl(value)).toBe(false);
    expect(safeHttpUrl(value)).toBeUndefined();
  });

  it('rejects non-string values', () => {
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(safeHttpUrl(42)).toBeUndefined();
  });
});

describe('validateEntry source_link scheme', () => {
  const base = {
    company: 'Acme',
    date_announced: '2026-01-01',
    status: 'confirmed',
    event_id: 'acme-2026-01',
  } as unknown as LayoffEntry;

  it('flags a javascript: source link as a hard error', () => {
    const errors = validateEntry({ ...base, source_link: 'javascript:alert(1)' }, 0);
    expect(errors.some((e) => e.field === 'source_link')).toBe(true);
  });

  it('does not flag an https source link', () => {
    const errors = validateEntry({ ...base, source_link: 'https://example.com/a' }, 0);
    expect(errors.some((e) => e.field === 'source_link')).toBe(false);
  });
});
