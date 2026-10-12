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

test('sameSource requires full identity and permits only sub-millisecond timestamp rounding', () => {
  const stat = { size: 20, dev: 1, ino: 4, mtimeMs: 1200.123, ctimeMs: 1250.567 };
  assert.equal(createReadAlong.sameSource(stat, { ...stat, mtimeMs: 1200, ctimeMs: 1251 }), true);
  for (const key of ['size', 'dev', 'ino', 'mtimeMs', 'ctimeMs']) {
    assert.equal(createReadAlong.sameSource(stat, { ...stat, [key]: stat[key] + 1 }), false, key);
  }
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

test('missing and corrupt documents fail quietly without exposing paths or tool errors', async t => {
  const f = await fixture(t);
  await fs.promises.unlink(f.sidecar);
  let result = await f.reader.get(ID, f.audio);
  assert.equal(result.available, false); assert.match(result.message, /not available/);
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
    audioReadAlong: { get: async (...args) => { calls.push(args); return { available: false, message: 'Not prepared' }; } } };
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
