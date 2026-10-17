const zlib = require('node:zlib');
const { promisify } = require('node:util');

// A large document that rarely changes (a word-timed read-along book is ~5 MB of
// JSON) is compressed once per version, as small as the browser accepts, and the
// bytes are reused. The shared gzipJson middleware uses gzip level 1 for every
// response, which suits small, frequent ones; for a book, brotli is a third
// smaller (2.1 MB -> 1.5 MB for book 3) and its cost is paid once, not per open.
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
function compress(encoding, buffer) {
  return encoding === 'br'
    ? brotli(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length } })
    : gzip(buffer, { level: 6 });
}

function acceptedEncoding(header) {
  const weights = new Map();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...parameters] = part.split(';').map(value => value.trim());
    const q = parameters.find(value => value.startsWith('q='));
    weights.set(name, q ? Number(q.slice(2)) : 1);
  }
  return ['br', 'gzip'].find(name => weights.get(name) > 0) || null;
}

module.exports = function createCompressedJson({ maxEntries = 4, compress: encode = compress } = {}) {
  const bodies = new Map();
  function body(tag, encoding, value) {
    const key = `${encoding} ${tag}`;
    let pending = bodies.get(key);
    if (pending) { bodies.delete(key); bodies.set(key, pending); return pending; }
    pending = Promise.resolve().then(() => encode(encoding, Buffer.from(JSON.stringify(value))));
    bodies.set(key, pending);
    pending.catch(() => { if (bodies.get(key) === pending) bodies.delete(key); });
    while (bodies.size > maxEntries) bodies.delete(bodies.keys().next().value);
    return pending;
  }
  // tag must identify value's version (the route's ETag does).
  async function send(req, res, tag, value) {
    res.vary('Accept-Encoding');
    const encoding = acceptedEncoding(req.headers['accept-encoding']);
    if (!encoding) return res.json(value);
    let buffer;
    try { buffer = await body(tag, encoding, value); } catch { return res.json(value); }
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': encoding, 'Content-Length': String(buffer.length) });
    res.end(buffer);
  }
  return { send, snapshot: () => ({ keys: [...bodies.keys()] }) };
};
module.exports.acceptedEncoding = acceptedEncoding;
module.exports.compress = compress;
