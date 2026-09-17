// Normalise a source URL for duplicate detection: drop the Wayback prefix, tracking
// query strings, and trailing slashes so the same underlying article matches.
// Shared by validate.ts (duplicate-source integrity check) and deduplicate.ts
// (scrape-time isDuplicate) so both sides agree on what "same URL" means.
export function normalizeUrl(url: string): string {
  if (!url) return '';
  let u = url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+\//, '');
  // layoffsg.com/feed identifies each event SOLELY by its ?event= id — the path is
  // always "/feed". Stripping the query (as we do for tracking params below) would
  // collapse every distinct layoffsg event to one URL, producing bogus duplicate-source
  // and cross-file-contradiction warnings for unrelated events. Keep the event id.
  const lsg = u.match(/layoffsg\.com\/feed\?[^#]*\bevent=([0-9a-z]+)/i);
  if (lsg) return `https://layoffsg.com/feed?event=${lsg[1].toLowerCase()}`;
  u = u.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return u.toLowerCase();
}
