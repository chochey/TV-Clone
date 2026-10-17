const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const createReadAlong = require('./audio-read-along');
const media = require('./library-media');

const ID = '55d3554fdb2887c9';
const ID2 = 'aa33554fdb2887c9';
const identity = stat => Object.fromEntries(['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino'].map(key => [key, stat[key]]));
const fixtureDocument = source => ({ version: 1, itemId: ID, title: 'Fixture Book', source: { ...source, pdfSha256: 'private-digest', method: 'private-method' },
  duration: 180, chapters: [
    { id: 'chapter-1', title: 'Opening', start: 20.619, end: 100, paragraphs: [
      { id: 'p-1', text: 'The first sentence.', start: 20.619, end: 40, page: 7 },
      { id: 'p-2', text: 'The next sentence.', start: 42, end: 90, page: 8 },
    ] },
    { id: 'chapter-2', title: 'Next chapter', start: 110, end: 170, paragraphs: [
      { id: 'p-3', text: 'A later passage.', start: 112, end: 165, page: 9 },
    ] },
  ] });

async function fixture(t, options = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tvclone-read-along-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const audio = path.join(directory, 'fixture.m4b'), sidecar = path.join(directory, 'read-along', `${ID}.json`);
  await fs.promises.writeFile(audio, 'synthetic audio source');
  await fs.promises.mkdir(path.dirname(sidecar));
  const source = identity(await fs.promises.stat(audio));
  const document = fixtureDocument(source);
  const write = value => fs.promises.writeFile(sidecar, JSON.stringify(value));
  await write(document);
  return { directory, audio, sidecar, source, document, write, reader: createReadAlong({ DATA_DIR: directory, ...options }) };
}

test('prepared paragraphs preserve gaps, introductory/trailing audio and expose only public fields', async t => {
  const f = await fixture(t);
  f.document.source.path = '/private/source.pdf'; f.document.secret = 'private-top-level';
  f.document.chapters[0].paragraphs[0].secret = '/private/paragraph';
  await f.write(f.document);
  const ready = await f.reader.get(ID, f.audio);
  assert.equal(ready.available, true); assert.equal(ready.chapters[0].start, 20.619);
  assert.equal(ready.chapters[1].paragraphs[0].end, 165); assert.equal(ready.duration, 180);
  assert.deepEqual(Object.keys(ready).sort(), ['available', 'chapters', 'duration', 'itemId', 'title', 'version']);
  assert.ok(!JSON.stringify(ready).includes('private')); assert.ok(!JSON.stringify(ready).includes(f.directory));
  assert.equal(await f.reader.get(ID, f.audio), ready, 'unchanged source and document reuse validated data');
  assert.equal(f.reader.snapshot().cached, 1);
});

test('a prepared document has a validator that moves only when its text or audiobook changes', async t => {
  const f = await fixture(t);
  const first = await f.reader.get(ID, f.audio), tag = f.reader.etag(first);
  assert.match(tag, /^W\/"ra-[A-Za-z0-9_-]{20,}"$/);
  assert.equal(f.reader.etag(await f.reader.get(ID, f.audio)), tag, 'unchanged files keep their tag');
  assert.ok(!tag.includes(f.directory) && !tag.includes('fixture'), 'the tag reveals nothing about the files');
  f.document.chapters[0].paragraphs[0].words = [[0, 3, 21, 22]]; await f.write(f.document);
  const updated = await f.reader.get(ID, f.audio);
  assert.equal(updated.chapters[0].paragraphs[0].words.length, 1);
  assert.notEqual(f.reader.etag(updated), tag, 'republished word timings must reach the browser');
  // A restart may change what the server sends for the same files.
  const restarted = createReadAlong({ DATA_DIR: f.directory });
  assert.notEqual(restarted.etag(await restarted.get(ID, f.audio)), f.reader.etag(updated));
  await fs.promises.unlink(f.sidecar);
  const missing = await f.reader.get(ID, f.audio);
  assert.equal(missing.available, false); assert.equal(f.reader.etag(missing), undefined, 'unavailable answers are never cached');
  assert.equal(f.reader.etag({ available: true }), undefined, 'only documents this reader validated have a tag');
});

test('sameSource tracks content, not filesystem placement, and tolerates sub-millisecond rounding', () => {
  const stat = { size: 20, dev: 1, ino: 4, mtimeMs: 1200.123, ctimeMs: 1250.567 };
  assert.equal(createReadAlong.sameSource(stat, { ...stat, mtimeMs: 1200 }), true);
  // Content signals: a real edit moves at least one of these.
  for (const key of ['size', 'mtimeMs']) {
    assert.equal(createReadAlong.sameSource(stat, { ...stat, [key]: stat[key] + 1 }), false, key);
  }
  // Regression: every audiobook read as "changed" after a reboot because the
  // library sits on a mergerfs union, which renumbers inodes on each mount.
  // dev/ino/ctime move without the audio changing and must not invalidate text.
  for (const key of ['dev', 'ino', 'ctimeMs']) {
    assert.equal(createReadAlong.sameSource(stat, { ...stat, [key]: stat[key] + 1 }), true, key);
  }
  assert.equal(createReadAlong.sameSource(stat, { ...stat, dev: 39, ino: 987186, ctimeMs: 99999 }), true);
  // An incomplete sidecar identity is still rejected outright.
  assert.equal(createReadAlong.sameSource({ size: 20, mtimeMs: 1200 }, stat), false);
});

test('invalid documents, non-text content and invalid time ranges cannot be served', () => {
  const valid = fixtureDocument({ size: 20, dev: 1, ino: 4, mtimeMs: 1200, ctimeMs: 1250 });
  const mutations = [
    d => { d.version = 2; }, d => { d.itemId = ID2; }, d => { delete d.source.ctimeMs; },
    d => { d.duration = Infinity; }, d => { d.duration = 99; }, d => { d.chapters = []; },
    d => { d.chapters[1].start = 99; }, d => { d.chapters[0].start = -1; },
    d => { delete d.chapters[0].id; }, d => { d.chapters[1].id = d.chapters[0].id; },
    d => { d.chapters[0].paragraphs[0].start = 20; },
    d => { d.chapters[0].paragraphs[0].end = 101; },
    d => { d.chapters[0].paragraphs[1].start = 39; },
    d => { d.chapters[0].paragraphs[0].end = d.chapters[0].paragraphs[0].start; },
    d => { d.chapters[0].paragraphs[0].start = NaN; },
    d => { d.chapters[0].paragraphs[0].start = '21'; },
    d => { delete d.chapters[0].paragraphs[0].id; },
    d => { d.chapters[1].paragraphs[0].id = 'p-1'; },
    d => { d.chapters[0].paragraphs[0].page = 0; },
    d => { d.chapters[0].paragraphs[0].text = '<script>alert(1)</script>'; },
    d => { d.chapters[0].paragraphs[0].text = 'bad\u0000text'; },
    d => { d.chapters[0].paragraphs[0].text = 'x'.repeat(12001); },
    d => { d.chapters[0].title = { html: 'unsafe' }; },
  ];
  for (const mutate of mutations) {
    const doc = structuredClone(valid); mutate(doc);
    assert.throws(() => createReadAlong.parseDocument(doc, ID), /Invalid read-along/);
  }
});

test('optional word timing tuples preserve exact text offsets, punctuation and audio gaps', () => {
  const doc = fixtureDocument({ size: 20, dev: 1, ino: 4, mtimeMs: 1200, ctimeMs: 1250 });
  const paragraph = doc.chapters[0].paragraphs[0];
  paragraph.text = '  Hello, 🐈 world!  ';
  paragraph.words = [[2, 8, 21, 22], [9, 11, 23, 24], [12, 18, 25, 27]];
  const ready = createReadAlong.parseDocument(doc, ID), output = ready.chapters[0].paragraphs[0];
  assert.equal(output.text, paragraph.text, 'trimming must not shift word offsets');
  assert.deepEqual(output.words, paragraph.words);
  assert.deepEqual(output.words.map(([start, end]) => output.text.slice(start, end)), ['Hello,', '🐈', 'world!']);
  assert.equal(Object.hasOwn(ready.chapters[0].paragraphs[1], 'words'), false, 'old paragraph-only data remains supported');
  assert.notEqual(output.words, paragraph.words); assert.notEqual(output.words[0], paragraph.words[0]);
  paragraph.words[0][0] = 99; assert.equal(output.words[0][0], 2, 'response is an independent allowlisted value');
});

test('malformed, excessive, overlapping and out-of-bounds word timing tuples are rejected', () => {
  const valid = fixtureDocument({ size: 20, dev: 1, ino: 4, mtimeMs: 1200, ctimeMs: 1250 });
  valid.chapters[0].paragraphs[0].text = 'Hello 🐈 world';
  const badWords = [
    undefined, null, {}, [], 'word', [[0, 5, 21]], [[0, 5, 21, 22, 'private']], [null],
    [['0', 5, 21, 22]], [[0, 1.1, 21, 22]], [[-1, 5, 21, 22]], [[0, 99, 21, 22]],
    [[5, 5, 21, 22]], [[0, 5, NaN, 22]], [[0, 5, 21, Infinity]], [[0, 5, '21', 22]],
    [[0, 5, 20, 22]], [[0, 5, 21, 41]], [[0, 5, 22, 22]], [[0, 5, 23, 22]],
    [[0, 5, 21, 23], [9, 14, 22, 24]], [[0, 5, 21, 22], [4, 8, 23, 24]],
    [[6, 7, 21, 22]], [[7, 8, 21, 22]], [[5, 6, 21, 22]],
    Array.from({ length: 6001 }, () => [0, 1, 21, 22]),
  ];
  for (const words of badWords) {
    const doc = structuredClone(valid); doc.chapters[0].paragraphs[0].words = words;
    assert.throws(() => createReadAlong.parseDocument(doc, ID), /Invalid read-along/);
  }
});

test('aggregate word timings are bounded across chapters and paragraphs', () => {
  const doc = fixtureDocument({ size: 20, dev: 1, ino: 4, mtimeMs: 1200, ctimeMs: 1250 });
  doc.duration = 4000;
  doc.chapters = [{ id: 'bounded', title: 'Bounded', start: 0, end: 4000, paragraphs: [] }];
  for (let p = 0; p < 51; p++) {
    const count = p === 50 ? 1 : 6000, start = p * 70;
    doc.chapters[0].paragraphs.push({ id: `p-${p}`, text: 'a '.repeat(count), start, end: start + 60, page: 1,
      words: Array.from({ length: count }, (_, w) => [w * 2, w * 2 + 1, start + w / 100, start + (w + 1) / 100]) });
  }
  assert.throws(() => createReadAlong.parseDocument(doc, ID), /Invalid read-along word count/);
});

test('word-timing sidecars larger than the old paragraph-only limit load privately', async t => {
  const f = await fixture(t);
  f.document.chapters[0].paragraphs[0].words = [[0, 3, 21, 22], [4, 9, 23, 24], [10, 19, 25, 27]];
  // JSON whitespace padding exercises the on-disk limit without artificial book text.
  await fs.promises.writeFile(f.sidecar, JSON.stringify(f.document) + ' '.repeat(4 * 1024 * 1024));
  const result = await f.reader.get(ID, f.audio);
  assert.equal(result.available, true);
  assert.deepEqual(result.chapters[0].paragraphs[0].words, f.document.chapters[0].paragraphs[0].words);
  assert.equal(createReadAlong.MAX_FILE_BYTES, 16 * 1024 * 1024);
});

test('a word-timed book just over the old 8 MiB limit loads and stays cached', async t => {
  // Regression: book 7's word timings reached 8.4 MB and its job could not publish.
  let opens = 0;
  const io = { ...fs.promises, open: async (...args) => { opens++; return fs.promises.open(...args); } };
  const f = await fixture(t, { io });
  await fs.promises.writeFile(f.sidecar, JSON.stringify(f.document) + ' '.repeat(9 * 1024 * 1024));
  assert.equal((await f.reader.get(ID, f.audio)).available, true);
  assert.equal((await f.reader.get(ID, f.audio)).available, true);
  assert.equal(opens, 1, 'one large document fits the default cache, so it is not re-read on every open');
});

test('missing and corrupt documents fail quietly without exposing paths or tool errors', async t => {
  const f = await fixture(t);
  await fs.promises.unlink(f.sidecar);
  let result = await f.reader.get(ID, f.audio);
  assert.equal(result.available, false); assert.match(result.message, /has not been prepared/);
  // Nothing prepares this text in the background, so the UI must not offer a
  // retry that can never succeed. Only a busy reader is worth trying again.
  assert.equal(result.retryable, false);
  await fs.promises.writeFile(f.sidecar, '{ corrupt /private/source.pdf');
  result = await f.reader.get(ID, f.audio);
  assert.equal(result.available, false); assert.match(result.message, /prepared again/);
  assert.ok(!JSON.stringify(result).includes('/private'));
});

test('source replacement, modification and disappearance invalidate already cached text', async t => {
  const f = await fixture(t);
  assert.equal((await f.reader.get(ID, f.audio)).available, true);
  await fs.promises.appendFile(f.audio, 'changed');
  let result = await f.reader.get(ID, f.audio);
  assert.equal(result.available, false); assert.match(result.message, /audiobook has changed/);
  assert.equal(f.reader.snapshot().cached, 0);
  f.document.source = identity(await fs.promises.stat(f.audio)); await f.write(f.document);
  assert.equal((await f.reader.get(ID, f.audio)).available, true);
  await fs.promises.unlink(f.audio);
  result = await f.reader.get(ID, f.audio);
  assert.equal(result.available, false); assert.equal(f.reader.snapshot().cached, 0);
});

test('replacement sidecars are revalidated and symlink or oversized files are never opened', async t => {
  let opens = 0;
  const io = { ...fs.promises, open: async (...args) => { opens++; return fs.promises.open(...args); } };
  const f = await fixture(t, { io });
  assert.equal((await f.reader.get(ID, f.audio)).available, true);
  f.document.chapters[0].paragraphs[0].text = 'A corrected passage.'; await f.write(f.document);
  assert.equal((await f.reader.get(ID, f.audio)).chapters[0].paragraphs[0].text, 'A corrected passage.');
  const count = opens;
  await fs.promises.unlink(f.sidecar); await fs.promises.symlink(f.audio, f.sidecar);
  assert.equal((await f.reader.get(ID, f.audio)).available, false);
  await fs.promises.unlink(f.sidecar); await fs.promises.writeFile(f.sidecar, ' '.repeat(createReadAlong.MAX_FILE_BYTES + 1));
  assert.equal((await f.reader.get(ID, f.audio)).available, false);
  assert.equal(opens, count);
});

test('source changes while reading cannot publish mismatched text', async t => {
  let stats = 0;
  const io = { ...fs.promises, stat: async (...args) => {
    const value = await fs.promises.stat(...args); stats++;
    if (stats === 2) value.mtimeMs += 2;
    return value;
  } };
  const f = await fixture(t, { io });
  const result = await f.reader.get(ID, f.audio);
  assert.equal(result.available, false); assert.match(result.message, /audiobook has changed/);
  assert.equal(f.reader.snapshot().cached, 0);
});

test('path attacks, protected formats and nonaudio files never reach filesystem access', async () => {
  let reads = 0;
  const reader = createReadAlong({ DATA_DIR: '/unused', io: { stat: async () => { reads++; throw Error('must not read'); } } });
  for (const [id, file] of [['../../etc/passwd', '/book.m4b'], [ID, 'relative.m4b'], [ID, '/book.aax'], [ID, '/film.mp4'], [ID, undefined], ['f'.repeat(17), '/book.m4b']]) {
    assert.equal((await reader.get(id, file)).available, false);
  }
  assert.equal(reads, 0);
});

test('aggregate cached bytes are bounded and a timed-out stat retains its pending slot', async t => {
  const f = await fixture(t, { maxCacheBytes: 64 });
  assert.equal((await f.reader.get(ID, f.audio)).available, true);
  assert.deepEqual(f.reader.snapshot(), { cached: 0, cacheBytes: 0, pending: 0 });
  let finish;
  const reader = createReadAlong({ DATA_DIR: '/unused', timeoutMs: 10, maxPending: 1,
    io: { stat: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = reader.get(ID, '/book.m4b');
  assert.equal(reader.get(ID, '/book.m4b'), pending);
  assert.equal((await reader.get(ID2, '/other.m4b')).available, false);
  assert.equal((await pending).available, false); assert.equal(reader.snapshot().pending, 1);
  finish({ isFile: () => false }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reader.snapshot().pending, 0);
});

test('actual read-along route keeps auth, profile isolation and authoritative audio resolution', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const auth = () => {}, ensure = () => {}, calls = [], routes = new Map();
  const audio = '/private/catalog/book.m4b';
  const catalog = [{ id: ID, mediaKind: 'audio' }, { id: ID2, mediaKind: 'movie' }];
  const context = { ...media, app: { get: (route, ...handlers) => routes.set(route, handlers) }, requireAuth: auth,
    ensureLibrary: ensure, getRequestProfile: req => req.denied ? null : 'viewer',
    scanLibrary: () => catalog, fileIndex: { [ID]: audio, [ID2]: '/private/movie.mp4' },
    audioReadAlong: { get: async (...args) => { calls.push(args); return { available: false, message: 'Not prepared' }; }, etag: () => undefined } };
  vm.runInNewContext(source.slice(source.indexOf("app.get('/api/audio/read-along/:id'"), source.indexOf("app.put('/api/subtitle-offset/:id'")), context);
  const handlers = routes.get('/api/audio/read-along/:id');
  assert.equal(handlers[0], auth); assert.equal(handlers[1], ensure);
  const request = async req => {
    const res = { code: 200, headers: {}, status(code) { this.code = code; return this; },
      set(key, value) { this.headers[key] = value; return this; }, json(value) { this.body = value; return this; } };
    await handlers.at(-1)({ params: { id: ID }, query: { path: '/etc/passwd' }, ...req }, res); return res;
  };
  assert.equal((await request({ denied: true })).code, 403); assert.equal(calls.length, 0);
  assert.equal((await request({ params: { id: ID2 } })).code, 404); assert.equal(calls.length, 0);
  assert.equal((await request({ params: { id: '../../etc/passwd' } })).code, 404);
  const ready = await request({});
  assert.equal(ready.code, 200); assert.deepEqual(calls, [[ID, audio]]);
  assert.match(ready.headers['Cache-Control'], /private, no-store/); assert.ok(!JSON.stringify(ready.body).includes('/private'));
  context.fileIndex[ID] = '/private/protected.aax'; assert.equal((await request({})).code, 404);
  context.fileIndex[ID] = '/private/notaudio.mp4'; assert.equal((await request({})).code, 404);
  assert.equal(calls.length, 1);
});

test('a prepared document is kept by the browser and revalidated instead of downloaded again', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routes = new Map(), prepared = { available: true, title: 'Fixture Book', chapters: [] };
  let answer = prepared;
  const context = { ...media, app: { get: (route, ...handlers) => routes.set(route, handlers) }, requireAuth() {},
    ensureLibrary() {}, getRequestProfile: () => 'viewer', scanLibrary: () => [{ id: ID, mediaKind: 'audio' }],
    fileIndex: { [ID]: '/private/catalog/book.m4b' },
    audioReadAlong: { get: async () => answer, etag: value => value === prepared ? 'W/"ra-v1"' : undefined },
    readAlongBodies: require('./compressed-json')() };
  vm.runInNewContext(source.slice(source.indexOf("app.get('/api/audio/read-along/:id'"), source.indexOf("app.put('/api/subtitle-offset/:id'")), context);
  const request = async (req = {}) => {
    const res = { code: 200, headers: {}, status(code) { this.code = code; return this; }, vary(field) { this.headers.Vary = field; return this; },
      set(key, value) { Object.assign(this.headers, typeof key === 'string' ? { [key]: value } : key); return this; },
      json(value) { this.body = value; return this; }, end(value) { this.ended = value; return this; } };
    await routes.get('/api/audio/read-along/:id').at(-1)({ params: { id: ID }, headers: { 'accept-encoding': 'gzip, br' }, ...req }, res);
    return res;
  };
  const first = await request();
  assert.equal(first.code, 200); assert.equal(first.headers.ETag, 'W/"ra-v1"');
  assert.equal(first.headers['Cache-Control'], 'private, no-cache');
  assert.equal(first.headers['Content-Encoding'], 'br');
  assert.deepEqual(JSON.parse(require('node:zlib').brotliDecompressSync(first.ended)), prepared);
  // Express sets req.fresh when If-None-Match carries the current ETag.
  const again = await request({ fresh: true });
  assert.equal(again.code, 304); assert.equal(again.ended, undefined); assert.equal(again.body, undefined);
  answer = { available: false, message: 'Not prepared', retryable: false };
  const missing = await request({ fresh: true });
  assert.equal(missing.code, 200); assert.deepEqual(missing.body, answer);
  assert.equal(missing.headers['Cache-Control'], 'private, no-store', 'an unavailable answer is never kept');
  assert.equal(missing.headers.ETag, undefined);
});

test('a book prepared from an EPUB alone has no page numbers and still loads', () => {
  // Pages come from a print edition. The player shows "Page N" only when one
  // exists, so an EPUB-only book must validate rather than be rejected --
  // fabricating page numbers would display invented data as fact.
  const doc = fixtureDocument({ size: 20, dev: 1, ino: 4, mtimeMs: 1200, ctimeMs: 1250 });
  for (const chapter of doc.chapters) for (const paragraph of chapter.paragraphs) delete paragraph.page;
  const parsed = createReadAlong.parseDocument(doc, ID);
  assert.equal(parsed.available, true);
  assert.equal(Object.hasOwn(parsed.chapters[0].paragraphs[0], 'page'), false);
  // A page that is present must still be a sane positive integer.
  for (const bad of [0, -1, 1.5, '7', null, 100001]) {
    const invalid = fixtureDocument({ size: 20, dev: 1, ino: 4, mtimeMs: 1200, ctimeMs: 1250 });
    invalid.chapters[0].paragraphs[0].page = bad;
    assert.throws(() => createReadAlong.parseDocument(invalid, ID), /Invalid read-along paragraph/, String(bad));
  }
});
