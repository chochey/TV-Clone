const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const createCompressedJson = require('./compressed-json');
const { acceptedEncoding } = createCompressedJson;

const document = { title: 'Fixture Book', chapters: Array.from({ length: 200 }, (_, i) => ({ id: `c-${i}`, text: 'The same sentence again. '.repeat(20) })) };
function response() {
  return { headers: {}, varied: [], status: 200,
    vary(field) { this.varied.push(field); return this; },
    set(fields) { Object.assign(this.headers, fields); return this; },
    json(value) { this.json = value; return this; },
    end(body) { this.body = body; return this; } };
}
const request = acceptEncoding => ({ headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding } });

test('the smallest encoding the browser accepts is chosen, honouring refusals', () => {
  assert.equal(acceptedEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(acceptedEncoding('gzip, deflate'), 'gzip');
  assert.equal(acceptedEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(acceptedEncoding('BR'), 'br');
  assert.equal(acceptedEncoding('identity'), null);
  assert.equal(acceptedEncoding('gzip;q=0'), null);
  assert.equal(acceptedEncoding(''), null);
  assert.equal(acceptedEncoding(undefined), null);
});

test('a document is compressed once per version and the same bytes are reused', async () => {
  const calls = [];
  const bodies = createCompressedJson({ compress: async (encoding, buffer) => { calls.push(encoding); return createCompressedJson.compress(encoding, buffer); } });
  const first = response();
  await bodies.send(request('gzip, deflate, br'), first, 'W/"v1"', document);
  assert.equal(first.headers['Content-Encoding'], 'br');
  assert.match(first.headers['Content-Type'], /^application\/json/);
  assert.equal(first.headers['Content-Length'], String(first.body.length));
  assert.deepEqual(first.varied, ['Accept-Encoding']);
  assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(first.body)), document);
  const again = response();
  await bodies.send(request('gzip, deflate, br'), again, 'W/"v1"', document);
  assert.equal(again.body, first.body);
  const gzip = response();
  await bodies.send(request('gzip'), gzip, 'W/"v1"', document);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gzip.body)), document);
  const changed = response();
  await bodies.send(request('br'), changed, 'W/"v2"', { ...document, title: 'Republished' });
  assert.equal(JSON.parse(zlib.brotliDecompressSync(changed.body)).title, 'Republished');
  assert.deepEqual(calls, ['br', 'gzip', 'br']);
});

test('requests that arrive together share one compression', async () => {
  let calls = 0;
  const bodies = createCompressedJson({ compress: async (encoding, buffer) => { calls++; await new Promise(r => setTimeout(r, 20)); return createCompressedJson.compress(encoding, buffer); } });
  const responses = [response(), response(), response()];
  await Promise.all(responses.map(res => bodies.send(request('br'), res, 'W/"v1"', document)));
  assert.equal(calls, 1);
  assert.ok(responses.every(res => res.body === responses[0].body));
});

test('kept bodies are bounded, least recently used first', async () => {
  const bodies = createCompressedJson({ maxEntries: 2 });
  for (const tag of ['a', 'b', 'a', 'c']) await bodies.send(request('gzip'), response(), tag, document);
  assert.deepEqual(bodies.snapshot().keys, ['gzip a', 'gzip c']);
});

test('without an accepted encoding, or when compression fails, the plain response is used', async () => {
  const plain = response();
  await createCompressedJson().send(request(undefined), plain, 'W/"v1"', document);
  assert.equal(plain.json, document); assert.equal(plain.body, undefined);
  let calls = 0;
  const bodies = createCompressedJson({ compress: async (encoding, buffer) => {
    if (++calls === 1) throw Error('compression failed');
    return createCompressedJson.compress(encoding, buffer);
  } });
  const failed = response();
  await bodies.send(request('br'), failed, 'W/"v1"', document);
  assert.equal(failed.json, document); assert.equal(failed.headers['Content-Encoding'], undefined);
  const retried = response();
  await bodies.send(request('br'), retried, 'W/"v1"', document);
  assert.equal(retried.headers['Content-Encoding'], 'br', 'a failure is not remembered');
});
