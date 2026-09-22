const test = require('node:test');
const assert = require('node:assert');
const { classifyTorrentUrl } = require('./torrent-url');

test('valid magnet identifiers are addable', () => {
  assert.strictEqual(classifyTorrentUrl('magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'magnet');
  assert.strictEqual(classifyTorrentUrl('MAGNET:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'magnet');
});

test('the real-world failure: a torrentproject details page is a page, not a torrent', () => {
  // This exact URL is what qBittorrent choked on ("bdecode:4"), leaving the
  // torrent stuck at "Fetching metadata" while the UI reported success.
  assert.strictEqual(
    classifyTorrentUrl('https://torrentproject.com.se/t3-3727491/The-Long-Night-Game-Of-Thrones-S8-E3-2019-1080p-Hotstar-DL-AVC-DD-2-0-Telly-torrent.html'),
    'page',
  );
});

test('web-page extensions are refused even when the word "torrent" appears', () => {
  for (const u of [
    'https://x.com/a/b.html',
    'http://x.com/details.htm',
    'https://site/foo.torrent.html',   // ends in .html -> page, despite ".torrent."
    'https://tracker/view.php?id=9',
    'https://tracker/t.aspx?id=9',
  ]) {
    assert.strictEqual(classifyTorrentUrl(u), 'page', u);
  }
});

test('a direct .torrent link is addable, query string or not', () => {
  assert.strictEqual(classifyTorrentUrl('https://x.com/file.torrent'), 'torrent');
  assert.strictEqual(classifyTorrentUrl('https://x.com/file.torrent?passkey=abc'), 'torrent');
});

test('extensionless download endpoints are allowed (many legit plugins use them)', () => {
  // Rejecting these would break real adds, so only known page shapes are refused.
  assert.strictEqual(classifyTorrentUrl('https://tracker/download.php/42/file'), 'torrent');
  assert.strictEqual(classifyTorrentUrl('https://tracker/dl/abc123'), 'torrent');
  assert.strictEqual(classifyTorrentUrl('https://tracker/download?id=42'), 'torrent');
});

test('a .php path that renders a page is refused, but a query on a real path is not', () => {
  assert.strictEqual(classifyTorrentUrl('https://tracker/get.php'), 'torrent');
  // Path is /download (no page extension); the .php is only in the query.
  assert.strictEqual(classifyTorrentUrl('https://tracker/download?src=get.php'), 'torrent');
});

test('non-URLs and junk are invalid', () => {
  assert.strictEqual(classifyTorrentUrl(''), 'invalid');
  assert.strictEqual(classifyTorrentUrl(null), 'invalid');
  assert.strictEqual(classifyTorrentUrl('   '), 'invalid');
  assert.strictEqual(classifyTorrentUrl('not a url'), 'invalid');
  assert.strictEqual(classifyTorrentUrl('ftp://x.com/f.torrent'), 'invalid');
  assert.strictEqual(classifyTorrentUrl('javascript:alert(1)'), 'invalid');
});

test('leading/trailing whitespace is tolerated', () => {
  assert.strictEqual(classifyTorrentUrl('  magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  '), 'magnet');
  assert.strictEqual(classifyTorrentUrl('  https://x.com/a.html '), 'page');
});

test('download.php handlers are handed to the downloader while malformed magnets are rejected', () => {
  assert.strictEqual(classifyTorrentUrl('https://example.test/download.php?id=42'), 'torrent');
  assert.strictEqual(classifyTorrentUrl('magnet:?xt=urn:btih:abc'), 'invalid');
  assert.strictEqual(classifyTorrentUrl('magnet:?dn=just-a-name'), 'invalid');
});
