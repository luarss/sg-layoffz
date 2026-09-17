import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../scripts/url-normalize';

describe('normalizeUrl', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeUrl('')).toBe('');
  });

  it('strips the Wayback wrapper prefix', () => {
    expect(
      normalizeUrl('https://web.archive.org/web/20260101000000/https://example.com/a')
    ).toBe(normalizeUrl('https://example.com/a'));
  });

  it('strips utm tracking query params', () => {
    expect(
      normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y')
    ).toBe(normalizeUrl('https://example.com/a'));
  });

  it('strips a hash fragment', () => {
    expect(normalizeUrl('https://example.com/a#section')).toBe(
      normalizeUrl('https://example.com/a')
    );
  });

  it('strips a trailing slash', () => {
    expect(normalizeUrl('https://example.com/a/')).toBe(normalizeUrl('https://example.com/a'));
  });

  it('treats http and https as equivalent', () => {
    expect(normalizeUrl('http://example.com/a')).toBe(normalizeUrl('https://example.com/a'));
  });

  it('drops a leading www. subdomain', () => {
    expect(normalizeUrl('https://www.example.com/a')).toBe(normalizeUrl('https://example.com/a'));
  });

  it('drops a trailing /amp path segment', () => {
    expect(normalizeUrl('https://example.com/news/article/amp')).toBe(
      normalizeUrl('https://example.com/news/article')
    );
  });

  it('drops a leading amp/ path segment', () => {
    expect(normalizeUrl('https://example.com/amp/news/article')).toBe(
      normalizeUrl('https://example.com/news/article')
    );
  });

  it('drops a .amp suffix', () => {
    expect(normalizeUrl('https://example.com/news/article.amp')).toBe(
      normalizeUrl('https://example.com/news/article')
    );
  });

  it('does not strip "amp" when it is only a substring of a path segment', () => {
    expect(normalizeUrl('https://example.com/amplify-podcast')).toBe(
      'example.com/amplify-podcast'
    );
  });

  it('drops an index.html suffix', () => {
    expect(normalizeUrl('https://example.com/news/index.html')).toBe(
      normalizeUrl('https://example.com/news')
    );
  });

  it('lowercases the result', () => {
    expect(normalizeUrl('https://Example.COM/A')).toBe('example.com/a');
  });

  it('normalizes scheme, www, trailing slash, and utm params together to the same value', () => {
    const variants = [
      'https://www.example.com/story/',
      'http://example.com/story?utm_source=fb&utm_campaign=share',
      'https://WWW.EXAMPLE.COM/STORY',
      'https://web.archive.org/web/20260215120000/https://www.example.com/story',
    ];
    const normalized = variants.map(normalizeUrl);
    for (const n of normalized) {
      expect(n).toBe(normalized[0]);
    }
  });

  it('preserves the layoffsg.com event id and ignores other query params', () => {
    expect(normalizeUrl('https://layoffsg.com/feed?event=ABC123&ref=share')).toBe(
      'https://layoffsg.com/feed?event=abc123'
    );
  });

  it('collapses layoffsg.com feed URLs that differ only by tracking params to the same event', () => {
    const a = normalizeUrl('https://layoffsg.com/feed?event=xyz789');
    const b = normalizeUrl('https://www.layoffsg.com/feed?event=XYZ789&utm_source=x');
    expect(a).toBe(b);
  });

  it('normalizes distinct Google News RSS wrapper URLs to distinct values per article id', () => {
    const a = normalizeUrl('https://news.google.com/rss/articles/CBMiAAA?oc=5');
    const b = normalizeUrl('https://news.google.com/rss/articles/CBMiBBB?oc=5');
    expect(a).not.toBe(b);
    // Re-fetching the SAME article id (e.g. with a different oc= or utm param) should
    // still collapse to the same normalized URL.
    const a2 = normalizeUrl('https://news.google.com/rss/articles/CBMiAAA?oc=3&utm_source=x');
    expect(a2).toBe(a);
  });
});
