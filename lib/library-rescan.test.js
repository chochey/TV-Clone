const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDirectoryLookup } = require('./fs-helpers');
const { preserveFailedEntries, libraryChanged, publicScanState } = require('./library-scan-state');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function scanner({ pool = false } = {}) {
  const rootA = pool ? '/mnt/media/Movies' : '/rootA', rootB = pool ? '/mnt/media/TV' : '/rootB';
  const dirs = new Map([
    [rootA, ['A.mp4', 'season/']], [rootA + '/season', ['Episode.mp4']], [rootB, ['B.mp4']],
  ]);
  const branchHealth = { degraded: false, unavailableBranches: [], poolMount: '/mnt/media' };
  const failures = new Set(), reads = new Map();
  const io = { readdir: async dir => {
    reads.set(dir, (reads.get(dir) || 0) + 1);
    if (failures.has(dir) || !dirs.has(dir)) throw Object.assign(new Error('Unavailable'), { code: 'EIO' });
    return dirs.get(dir).map(name => ({ name: name.replace(/\/$/, ''), isDirectory: () => name.endsWith('/'), isFile: () => !name.endsWith('/') }));
  } };
  const c = { libraryCache: null, libraryVersion: 0, libraryScanState: { degraded: false, failedLocations: [] },
    fileIndex: {}, posterIndex: {}, subtitleIndex: {},
    config: { folders: [{ path: rootA, type: 'movie' }, { path: rootB, type: 'movie' }], genres: {} },
    conversionStorage: { scanHealth: async () => branchHealth },
    fs: { promises: { stat: async () => ({ size: 100, mtimeMs: 1000 }) } }, path,
    createDirectoryLookup: () => createDirectoryLookup({ io }), preserveFailedEntries, libraryChanged,
    POSTER_EXT: ['.jpg'], SUBTITLE_EXT: ['.srt'], SUPPORTED_EXT: ['.mp4'], SKIP_DIRS: new Set(),
    parseTitle: file => ({ title: path.parse(file).name, year: 2020 }), detectType: () => 'movie', hashId: file => file,
    embeddedTracks: () => [], subProbeCache: {}, hasEpisodePattern: () => false, getStreamMode: () => 'direct',
    probeCache: {}, audioTracksCache: {}, LANG_CODES: {}, saveLibraryCache: () => {}, recordScan: () => {},
    requests: { matchLibrary: () => {} }, notifyClients: () => {}, queueAllSpriteGen: () => {}, setTimeout: () => {},
    console: { log: () => {}, warn: () => {} }, notifyLogLib: { groupAddedContent: () => [] }, notifyLog: { push: () => {} } };
  vm.createContext(c);
  const walk = source.slice(source.indexOf('async function walkDirAsync('), source.indexOf('let libraryCache = null;'));
  const scan = source.slice(source.indexOf('async function doRescan('), source.indexOf('// ── Profile APIs'));
  vm.runInContext(walk + scan, c);
  return { c, dirs, failures, reads, branchHealth, rootA, rootB, scan: () => vm.runInContext('doRescan("test")', c) };
}

test('a failed root or subtree retains its cached inventory while healthy deletions take effect', async () => {
  const s = scanner(); await s.scan();
  assert.equal(s.c.libraryCache.length, 3);
  s.failures.add('/rootB'); s.failures.add('/rootA/season'); s.dirs.set('/rootA', ['season/']);
  await s.scan();
  assert.deepEqual(Array.from(s.c.libraryCache, item => item.id), ['/rootB/B.mp4', '/rootA/season/Episode.mp4']);
  assert.equal(s.c.libraryScanState.degraded, true);
  assert.equal(s.c.libraryScanState.retainedCount, 2);
  assert.equal(s.c.fileIndex['/rootB/B.mp4'], '/rootB/B.mp4');
  s.failures.clear(); s.dirs.set('/rootB', []); await s.scan();
  assert.equal(s.c.libraryScanState.degraded, false);
  assert.deepEqual(Array.from(s.c.libraryCache, item => item.id), ['/rootA/season/Episode.mp4']);
});

test('artwork and subtitle additions change the catalog revision without changing video mtime', async () => {
  const s = scanner(); await s.scan(); const before = s.c.libraryVersion;
  s.dirs.set('/rootA', ['A.mp4', 'A.jpg', 'A.en.srt', 'season/']); await s.scan();
  assert.equal(s.c.libraryVersion, before + 1);
  assert.equal(s.c.libraryCache.find(item => item.title === 'A').posterUrl, '/poster//rootA/A.mp4');
  assert.equal(s.c.libraryCache.find(item => item.title === 'A').subtitles.length, 1);
  await s.scan(); assert.equal(s.c.libraryVersion, before + 1);
});

test('directory listings are shared by walk, poster and subtitle discovery', async () => {
  const s = scanner(); s.dirs.set('/rootA', ['A.mp4', 'A2.mp4', 'A.jpg', 'A.en.srt', 'season/']); await s.scan();
  assert.equal(s.reads.get('/rootA'), 1);
  assert.equal(s.reads.get('/rootA/season'), 1);
});

test('a failed subtitle directory keeps previously discovered tracks and indexes', async () => {
  const s = scanner();
  s.dirs.set('/rootA', ['A.mp4', 'subtitles/']); s.dirs.set('/rootA/subtitles', ['A.en.srt']);
  await s.scan(); const item = s.c.libraryCache.find(item => item.title === 'A'), sub = item.subtitles[0];
  s.failures.add('/rootA/subtitles'); await s.scan();
  const after = s.c.libraryCache.find(item => item.title === 'A');
  assert.equal(after.subtitles[0].id, sub.id); assert.equal(s.c.subtitleIndex[sub.id].absPath, '/rootA/subtitles/A.en.srt');
  assert.equal(s.c.libraryScanState.degraded, true);
});

test('an unexpectedly empty successful scan preserves the prior mountpoint inventory', async () => {
  const s = scanner(); await s.scan(); s.dirs.set('/rootA', []); s.dirs.set('/rootB', []); await s.scan();
  assert.equal(s.c.libraryCache.length, 3); assert.equal(s.c.libraryScanState.degraded, true);
});

test('an unavailable mergerfs branch preserves missing titles while healthy arrivals and later deletions work', async () => {
  const s = scanner({ pool: true }); await s.scan();
  s.branchHealth.degraded = true; s.branchHealth.unavailableBranches = ['/media/offline'];
  s.dirs.set(s.rootB, []); s.dirs.set(s.rootA, ['A.mp4', 'New.mp4', 'season/']); await s.scan();
  assert.equal(s.c.libraryCache.length, 4); assert.equal(s.c.libraryScanState.degraded, true);
  assert.equal(s.c.libraryCache.some(item => item.title === 'B'), true);
  assert.equal(s.c.libraryCache.some(item => item.title === 'New'), true);
  s.branchHealth.degraded = false; s.branchHealth.unavailableBranches = []; await s.scan();
  assert.equal(s.c.libraryCache.length, 3); assert.equal(s.c.libraryCache.some(item => item.title === 'B'), false);
});

test('explicitly unlinked roots are not retained and public status hides paths', async () => {
  const s = scanner(); await s.scan();
  s.c.config.folders = [{ path: '/rootA', type: 'movie' }]; s.failures.add('/rootA'); await s.scan();
  assert.equal(s.c.libraryCache.some(item => item.id.startsWith('/rootB')), false);
  assert.equal(publicScanState(s.c.libraryScanState).failedCount, 1);
  assert.equal('failedLocations' in publicScanState(s.c.libraryScanState), false);
});

test('conversion ordering uses cached sizes without touching the media filesystem', () => {
  const code = source.slice(source.indexOf('function eligibleContainerFiles('), source.indexOf('const conversionQueue ='));
  const c = { scanLibrary: () => [{ _filePath: '/large.mkv', fileSize: 200 }, { _filePath: '/small.mkv', fileSize: 10 }],
    audioTracksCache: {}, probeCache: {}, pixFmtCache: {}, audioProbeCache: {}, subProbeCache: {},
    fs: { statSync: () => { throw new Error('Must not stat files while sorting'); } }, classifyFile: () => ({ tier: 'container', hasImageSubs: false }) };
  vm.createContext(c); vm.runInContext(code, c);
  assert.deepEqual(Array.from(vm.runInContext('eligibleContainerFiles({tiers:{container:true}})', c)), ['/small.mkv', '/large.mkv']);
});
