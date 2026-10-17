const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('stream');
const { streamMediaFile, parseRange } = require('./direct-stream');

class Response extends Writable {
  constructor({ hold = false } = {}) { super(); this.headers = {}; this.statusCode = 200; this.chunks = []; this.hold = hold; }
  _write(chunk, _encoding, callback) { this.chunks.push(chunk); if (!this.hold) callback(); }
  status(code) { this.statusCode = code; return this; }
  set(name, value) { this.headers[name] = value; return this; }
  send(body) { this.end(body); return this; }
  writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); this.headersSent = true; }
}

test('direct stream handles suffix and oversized ranges and rejects invalid ranges', async () => {
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=2-100', 10), { start: 2, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), null);
  assert.equal(parseRange('bytes=0-1,3-4', 10), null);
  const res = new Response();
  await streamMediaFile({ method: 'GET', headers: { range: 'bytes=-3' } }, res, '/sample.mp4', {
    io: { promises: { stat: async () => ({ size: 10 }) }, createReadStream: (_file, range) => Readable.from(Buffer.from('0123456789').subarray(range.start, range.end + 1)) },
  });
  assert.equal(res.statusCode, 206); assert.equal(res.headers['Content-Range'], 'bytes 7-9/10');
  assert.equal(Buffer.concat(res.chunks).toString(), '789');
});

test('a disk read failure is contained and subsequent transfers still work', async () => {
  const errors = [], failed = new Response();
  await streamMediaFile({ method: 'GET', headers: {} }, failed, '/sample.mp4', {
    onError: error => errors.push(error.code),
    io: { promises: { stat: async () => ({ size: 10 }) }, createReadStream: () => new Readable({ read() { this.destroy(Object.assign(new Error('Read failed'), { code: 'EIO' })); } }) },
  });
  assert.deepEqual(errors, ['EIO']); assert.equal(failed.destroyed, true);
  const healthy = new Response();
  await streamMediaFile({ method: 'GET', headers: {} }, healthy, '/sample.mp4', {
    io: { promises: { stat: async () => ({ size: 2 }) }, createReadStream: () => Readable.from(Buffer.from('ok')) },
  });
  assert.equal(Buffer.concat(healthy.chunks).toString(), 'ok');
});

test('disconnects destroy the source reader and stat failures return a bounded response', async () => {
  let reader;
  const res = new Response({ hold: true });
  const transfer = streamMediaFile({ method: 'GET', headers: {} }, res, '/sample.mp4', {
    io: { promises: { stat: async () => ({ size: 1000000 }) }, createReadStream: () => (reader = new Readable({ read() { this.push(Buffer.alloc(16384)); } })) },
  });
  await new Promise(resolve => setImmediate(resolve)); res.destroy(); await transfer;
  assert.equal(reader.destroyed, true);
  const missing = new Response();
  await streamMediaFile({ method: 'GET', headers: {} }, missing, '/sample.mp4', {
    io: { promises: { stat: async () => { throw Object.assign(new Error('Unavailable'), { code: 'EIO' }); } } },
  });
  assert.equal(missing.statusCode, 503);
});

test('HEAD requests do not open a media read stream', async () => {
  const res = new Response();
  await streamMediaFile({ method: 'HEAD', headers: {} }, res, '/sample.mp4', {
    io: { promises: { stat: async () => ({ size: 100 }) }, createReadStream: () => { throw new Error('HEAD opened a reader'); } },
  });
  assert.equal(res.headers['Content-Length'], 100); assert.equal(res.chunks.length, 0);
});

test('audio streams have browser MIME types and support seek ranges and HEAD', async () => {
  const formats = {
    '.MP3': 'audio/mpeg', '.m4a': 'audio/mp4', '.M4B': 'audio/mp4', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  };
  for (const [ext, contentType] of Object.entries(formats)) {
    const body = Buffer.from('0123456789');
    let reads = 0;
    const io = {
      promises: { stat: async () => ({ size: body.length }) },
      createReadStream: (_file, range) => {
        reads++;
        return Readable.from(range ? body.subarray(range.start, range.end + 1) : body);
      },
    };
    const range = new Response();
    await streamMediaFile({ method: 'GET', headers: { range: 'bytes=3-6' } }, range, '/podcast' + ext, { io });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers['Content-Type'], contentType, ext);
    assert.equal(range.headers['Content-Range'], 'bytes 3-6/10');
    assert.equal(Buffer.concat(range.chunks).toString(), '3456');
    const head = new Response();
    await streamMediaFile({ method: 'HEAD', headers: {} }, head, '/podcast' + ext, { io });
    assert.equal(head.headers['Content-Type'], contentType);
    assert.equal(head.headers['Content-Length'], 10);
    assert.equal(reads, 1, 'HEAD must not read the audio file');
  }
});

test('extra headers ride on full and partial responses', async () => {
  const io = { promises: { stat: async () => ({ size: 10 }) }, createReadStream: (_file, range) => Readable.from(Buffer.from('0123456789').subarray(range?.start ?? 0, (range?.end ?? 9) + 1)) };
  const headers = { 'Cache-Control': 'private, max-age=31536000, immutable', ETag: '"copy-v1"' };
  for (const range of [undefined, 'bytes=2-4']) {
    const res = new Response();
    await streamMediaFile({ method: 'GET', headers: range ? { range } : {} }, res, '/book.lite.opus', { io, headers });
    assert.equal(res.headers['Cache-Control'], headers['Cache-Control']); assert.equal(res.headers.ETag, '"copy-v1"');
    assert.equal(res.headers['Content-Type'], 'audio/ogg');
  }
});
