const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const createAudioMetadata = require('./audio-metadata');
const { createChildRunner } = require('./media-process');
const media = require('./library-media');

const file = '/private/books/book.m4b';
const jpeg = Buffer.from([0xff, 0xd8, 0x42, 0xff, 0xd9]);
const statValue = (changed = 0) => ({ dev: 1, ino: 2, size: 200, mtimeMs: changed, ctimeMs: changed, isFile: () => true });
const document = {
  format: { duration: '120', filename: file, tags: { TITLE: 'The Book', ARTIST: 'Reader', album: 'Collection', secret: '/private/ignored' } },
  streams: [{ index: 0, codec_type: 'audio', duration: '120' }, { index: 2, codec_type: 'video', disposition: { attached_pic: 1 } }],
  chapters: [{ start_time: '60', end_time: '125', tags: { TITLE: 'Chapter Two' } },
    { start_time: '0', end_time: '60', tags: { title: 'Chapter One' } }],
};
const response = value => ({ stdout: JSON.stringify(value) });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('audio tags and chapters are allowlisted, sorted and bounded by duration', () => {
  const parsed = createAudioMetadata.parseMetadata({ ...document, chapters: [...document.chapters,
    { start_time: '-1', end_time: '3' }, { start_time: '110', end_time: '90' },
    { start_time: '130', end_time: '140' }, { start_time: 'bad', end_time: '10' }] });
  assert.deepEqual(parsed, { title: 'The Book', artist: 'Reader', album: 'Collection', duration: 120,
    chapters: [{ title: 'Chapter One', start: 0, end: 60 }, { title: 'Chapter Two', start: 60, end: 120 }], artworkStream: 2 });
  assert.ok(!JSON.stringify(parsed).includes('/private'));
  assert.equal(createAudioMetadata.parseMetadata({ streams: [{ codec_type: 'video' }] }), null);
  const untitled = createAudioMetadata.parseMetadata({ streams: [{ codec_type: 'audio', duration: '45', tags: { album_artist: 'Reader' } }],
    chapters: [{ start_time: '0', end_time: '20' }] });
  assert.equal(untitled.duration, 45); assert.equal(untitled.artist, 'Reader'); assert.equal(untitled.title, null);
  assert.deepEqual(untitled.chapters, [{ title: null, start: 0, end: 20 }]);
});

test('protected Audible, video and non-index-style relative paths never reach stat or media tools', async () => {
  let reads = 0;
  const metadata = createAudioMetadata({ stat: async () => { reads++; throw Error('must not read'); },
    probes: { run: async () => { throw Error('must not probe'); } } });
  for (const input of ['/private/book.AAX', '/private/book.aa', '/private/book.aaxc', '/private/movie.mp4', 'book.m4b', undefined]) {
    assert.equal(await metadata.get(input), null);
  }
  assert.equal(reads, 0);
});

test('metadata and artwork share in-flight work and cache by complete stat fingerprint', async () => {
  let release, probeCalls = 0, images = 0, identity = 0;
  const metadata = createAudioMetadata({ stat: async () => statValue(identity), probes: { run: async () => {
    probeCalls++; await new Promise(resolve => { release = resolve; }); return response(document);
  } }, images: { run: async (command, args, options) => {
    images++; assert.equal(command, 'ffmpeg'); assert.ok(args.includes('0:2'));
    assert.ok(args.includes('pipe:1')); assert.equal(options.encoding, null);
    assert.equal(options.maxStdoutBytes, createAudioMetadata.MAX_ARTWORK_BYTES);
    return { stdout: jpeg };
  } } });
  const first = metadata.get(file), duplicate = metadata.get(file);
  assert.equal(first, duplicate); await tick(); release();
  assert.equal((await first).title, 'The Book'); assert.equal((await metadata.get(file)).artwork, jpeg);
  assert.equal(probeCalls, 1); assert.equal(images, 1);
  identity++;
  const replaced = metadata.get(file); await tick(); release(); await replaced;
  assert.equal(probeCalls, 2); assert.equal(images, 2);
});

test('probe errors are quiet, negatively cached briefly and retry after expiry', async () => {
  let time = 100, calls = 0;
  const probes = { run: async () => { calls++; throw Error('/private/raw-tool-error'); } };
  const metadata = createAudioMetadata({ stat: async () => statValue(), now: () => time, failureRetryMs: 10, probes });
  assert.equal(await metadata.get(file), null); assert.equal(await metadata.get(file), null); assert.equal(calls, 1);
  time = 111; probes.run = async () => { calls++; return response({ ...document, streams: [document.streams[0]] }); };
  assert.equal((await metadata.get(file)).title, 'The Book'); assert.equal(calls, 2);
});

test('cover failure preserves audio metadata and permits a later bounded retry', async () => {
  let time = 100, calls = 0;
  const images = { run: async () => { calls++; return { stdout: Buffer.from('not a JPEG') }; } };
  const metadata = createAudioMetadata({ stat: async () => statValue(), now: () => time, failureRetryMs: 10,
    probes: { run: async () => response(document) }, images });
  assert.equal((await metadata.get(file)).artwork, null); assert.equal((await metadata.get(file)).duration, 120);
  assert.equal(calls, 1);
  time = 111; images.run = async () => { calls++; return { stdout: jpeg }; };
  assert.equal((await metadata.get(file)).artwork, jpeg); assert.equal(calls, 2);
});

test('changing a source during extraction cannot publish stale metadata or artwork', async () => {
  let reads = 0;
  const metadata = createAudioMetadata({ stat: async () => statValue(reads++),
    probes: { run: async () => response(document) }, images: { run: async () => ({ stdout: jpeg }) } });
  assert.equal(await metadata.get(file), null);
  assert.equal(metadata.snapshot().cached, 0);
});

test('in-flight work and cached artwork memory are bounded', async () => {
  const waiting = [];
  const metadata = createAudioMetadata({ maxPending: 2, maxCacheEntries: 2, maxCacheBytes: jpeg.length,
    stat: async () => statValue(), probes: { run: async () => {
      await new Promise(resolve => waiting.push(resolve)); return response(document);
    } }, images: { run: async () => ({ stdout: jpeg }) } });
  const first = metadata.get('/one.m4b'), second = metadata.get('/two.m4b');
  assert.equal(await metadata.get('/three.m4b'), null);
  await tick(); assert.equal(waiting.length, 2); for (const resolve of waiting) resolve();
  await Promise.all([first, second]);
  assert.deepEqual(metadata.snapshot(), { cached: 1, inFlight: 0, artworkBytes: jpeg.length });
});

test('caller deadline bounds a stuck stat while keeping its work slot until it settles', async () => {
  let finish;
  const metadata = createAudioMetadata({ maxPending: 1, timeoutMs: 10,
    stat: () => new Promise(resolve => { finish = resolve; }),
    probes: { run: async () => { throw Error('expired jobs must not probe'); } } });
  assert.equal(await metadata.get(file), null);
  assert.equal(metadata.snapshot().inFlight, 1);
  assert.equal(await metadata.get('/another.m4b'), null);
  finish(statValue()); await tick(); assert.equal(metadata.snapshot().inFlight, 0);
});

test('only an attached picture is extracted, never ordinary video tracks', async () => {
  let calls = 0;
  const metadata = createAudioMetadata({ stat: async () => statValue(),
    probes: { run: async () => response({ ...document, streams: [document.streams[0],
      { index: 1, codec_type: 'video', disposition: { attached_pic: 0 } },
      { index: '2', codec_type: 'video', disposition: { attached_pic: 1 } }] }) },
    images: { run: async () => { calls++; } } });
  assert.equal((await metadata.get(file)).artwork, null); assert.equal(calls, 0);
});

test('real M4B fixture exposes tags, duration, chapters and a resized embedded JPEG', async t => {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tvclone-audio-metadata-'));
  t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
  const runner = createChildRunner({ concurrency: 1, timeoutMs: 15000 });
  const cover = path.join(temporary, 'cover.ppm'), book = path.join(temporary, 'book.m4b');
  const chapters = path.join(temporary, 'chapters.txt');
  await fs.promises.writeFile(cover, Buffer.concat([Buffer.from('P6\n800 640\n255\n'), Buffer.alloc(800 * 640 * 3, 120)]));
  await fs.promises.writeFile(chapters, ';FFMETADATA1\ntitle=Fixture Audiobook\nartist=Fixture Reader\nalbum=Fixture Collection\n' +
    '[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n' +
    '[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Closing\n');
  await runner.run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', cover, '-f', 'ffmetadata', '-i', chapters,
    '-map', '0:a:0', '-map', '1:v:0', '-map_metadata', '2', '-map_chapters', '2',
    '-c:a', 'aac', '-c:v', 'mjpeg', '-threads', '1', '-disposition:v:0', 'attached_pic', '-f', 'mp4', book]);
  const metadata = createAudioMetadata({ probes: runner, images: runner });
  const actual = await metadata.get(book);
  assert.ok(actual); assert.equal(actual.title, 'Fixture Audiobook'); assert.equal(actual.artist, 'Fixture Reader');
  assert.equal(actual.album, 'Fixture Collection'); assert.ok(Math.abs(actual.duration - 2) < .1);
  assert.deepEqual(actual.chapters, [{ title: 'Opening', start: 0, end: 1 }, { title: 'Closing', start: 1, end: 2 }]);
  assert.ok(actual.artwork.length < createAudioMetadata.MAX_ARTWORK_BYTES);
  const output = path.join(temporary, 'extracted.jpg'); await fs.promises.writeFile(output, actual.artwork);
  const dimensions = JSON.parse((await runner.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', output])).stdout).streams[0];
  assert.equal(dimensions.width, 512); assert.equal(dimensions.height, 410);
  assert.equal((await metadata.get(book)).artwork, actual.artwork, 'cache reuses the resized bytes');
});

test('actual detail and artwork routes retain authentication, profile access and path privacy', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routes = new Map(), auth = () => {}, ensure = () => {}, reads = [];
  const book = { id: 'book', title: 'Filename title', mediaKind: 'audio', _filePath: file, folderPath: '/private/books', subtitles: [] };
  const context = { ...media, app: { get: (route, ...handlers) => routes.set(route, handlers) }, requireAuth: auth, ensureLibrary: ensure,
    scanLibrary: () => [book], getMetadataForItem: () => null, getRequestProfile: req => req.denied ? null : 'viewer',
    loadProfileData: () => ({ progress: {}, watched: {} }), fileIndex: { book: file, protected: '/private/book.aax' },
    audioMetadata: { get: async value => { reads.push(value); return value === file
      ? { title: 'Embedded title', artist: 'Reader', album: 'Collection', duration: 120, chapters: [], artwork: jpeg } : null; } },
    probeSubtitlesAsync: () => { throw Error('audio must not probe subtitles'); }, embeddedTracks: () => [] };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("app.get('/api/item/:id'"), source.indexOf("app.post('/api/progress'")), context);
  vm.runInContext(source.slice(source.indexOf("app.get('/audio-artwork/:id'"), source.indexOf('// Landscape backdrop')), context);
  const res = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
    set(headers) { Object.assign(this.headers, headers); return this; } });
  assert.equal(routes.get('/api/item/:id')[0], auth);
  assert.equal(routes.get('/audio-artwork/:id')[0], auth); assert.equal(routes.get('/audio-artwork/:id')[1], ensure);
  const detail = res(); await routes.get('/api/item/:id').at(-1)({ params: { id: 'book' } }, detail);
  assert.equal(detail.body.title, 'Filename title'); assert.equal(detail.body.audioMetadata.title, 'Embedded title');
  assert.equal(detail.body.audioMetadata.coverUrl, '/audio-artwork/book');
  assert.ok(!JSON.stringify(detail.body).includes('/private')); assert.ok(!('artwork' in detail.body.audioMetadata));
  const denied = res(); const priorReads = reads.length;
  await routes.get('/api/item/:id').at(-1)({ params: { id: 'book' }, denied: true }, denied);
  assert.equal(denied.code, 403); assert.equal(reads.length, priorReads);
  const art = res(); await routes.get('/audio-artwork/:id').at(-1)({ params: { id: 'book' }, query: { path: '/arbitrary/file' } }, art);
  assert.equal(art.body, jpeg); assert.equal(art.headers['Content-Type'], 'image/jpeg'); assert.match(art.headers['Cache-Control'], /private/);
  const absent = res(); await routes.get('/audio-artwork/:id').at(-1)({ params: { id: 'unknown' }, query: { path: file } }, absent);
  assert.equal(absent.code, 404);
  assert.deepEqual(reads, [file, file]);
});
