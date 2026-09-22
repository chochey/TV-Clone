// Classify what a "download" URL from a qBittorrent search result actually is,
// so the add endpoint can reject the one case that silently fails.
//
// Why this exists: qBittorrent search plugins populate each result's `fileUrl`
// with "the download link", but plugins disagree on what that is. Well-behaved
// ones give a magnet URI or a direct .torrent link. Others — torrentproject is
// the one caught in the wild — give the HTML *details page*
// (…/The-Long-Night…torrent.html). The add endpoint used to forward any http
// URL to qBittorrent, which accepts it, replies "Ok." (it only means "queued
// for async fetch"), then fails later trying to bdecode a web page:
//   "expected value (list, dict, int or string) in bencoded string [bdecode:4]"
// The torrent sits at "Fetching metadata" forever while the UI reported
// success. Catching the page URL up front turns that silent dead-end into an
// actionable message.
//
// Pure and dependency-free so it is trivially unit-testable.

// Returns one of:
//   'magnet'  — a magnet: URI, always addable
//   'torrent' — an http(s) URL that plausibly points at a .torrent payload
//   'page'    — an http(s) URL that is a web page, NOT a torrent (reject these)
//   'invalid' — neither a magnet nor an http(s) URL
function classifyTorrentUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return 'invalid';
  if (/^magnet:\?/i.test(url)) {
    const identifiers = new URLSearchParams(url.slice(url.indexOf('?') + 1)).getAll('xt');
    return identifiers.some(id => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(id)
      || /^urn:btmh:1220[a-f0-9]{64}$/i.test(id)) ? 'magnet' : 'invalid';
  }
  if (!/^https?:\/\//i.test(url)) return 'invalid';

  // Look only at the path, not the query — a real .torrent endpoint can carry
  // a query string (…/download.php?id=42), and a page can too.
  let pathname;
  try { pathname = new URL(url).pathname.toLowerCase(); } catch { return 'invalid'; }

  // Known download handlers are passed to qBittorrent for payload validation.
  if (/\/(?:download|dl|get)\.(?:php|asp|aspx)$/i.test(pathname)) return 'torrent';

  // Explicit web-page extensions are never a torrent payload. This is the
  // concrete failure mode observed (…torrent.html) and the false-positive risk
  // is nil: a torrent download link effectively never ends in .html/.htm/.php-
  // rendered-page etc. Note ".torrent.html" ends in .html and is correctly a
  // page, even though it contains the word "torrent".
  if (/\.(html?|php|asp|aspx|jsp)$/i.test(pathname)) return 'page';

  // A .torrent path is unambiguous.
  if (/\.torrent$/i.test(pathname)) return 'torrent';

  // Everything else (extensionless download endpoints, /download/<hash>, etc.)
  // is treated as a plausible torrent link — many legitimate plugins use these,
  // so rejecting them would break real adds. Only the known page shapes above
  // are refused.
  return 'torrent';
}

module.exports = { classifyTorrentUrl };
