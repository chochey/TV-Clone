const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDirectoryLookup } = require('./fs-helpers');
const { preserveFailedEntries, libraryChanged, publicScanState } = require('./library-scan-state');
const { extensionsForFolder, classifyMediaKind, isAudioFile, playbackIssueForFile } = require('./library-media');
const { sectionId } = require('./library-folders');
const { parseShowName, parseEpisodeInfo } = require('./filename-parse');
const { splitSquashedTitle, audioMetaEntry, audioMetaValid, probeAudioText } = require('./audio-title');
const { selectAudioTrack } = require('./audio-track-selection');
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
    mediaIdentity: {seed(){},begin(){},resolve:async file=>file,persist:async()=>{},revision:0,isCurrent:()=>true},
    config: { folders: [{ path: rootA, type: 'movie' }, { path: rootB, type: 'movie' }], genres: {} },
    conversionStorage: { scanHealth: async () => branchHealth },
    fs: { promises: { stat: async () => ({ size: 100, mtimeMs: 1000 }) } }, path,
    extensionsForFolder, classifyMediaKind, isAudioFile, playbackIssueForFile, sectionId,
    createDirectoryLookup: () => createDirectoryLookup({ io }), preserveFailedEntries, libraryChanged,
    POSTER_EXT: ['.jpg'], SUBTITLE_EXT: ['.srt'], SUPPORTED_EXT: ['.mp4'], SKIP_DIRS: new Set(),
    parseTitle: file => ({ title: path.parse(file).name, year: 2020 }), detectType: () => 'movie', hashId: file => file,
    parseShowName, parseEpisodeInfo, selectAudioTrack,
    embeddedTracks: () => [], subProbeCache: {}, hasEpisodePattern: () => false, getStreamMode: () => 'direct',
    probeCache: {}, audioTracksCache: {}, LANG_CODES: {}, saveLibraryCache: () => {}, recordScan: () => {},
    // Audiobook titles come from the file's own tags. The runner refuses to
    // probe, so these tests also prove the scan still completes -- falling back
    // to the split filename -- when a book cannot be read.
    audioMetaCache: {}, markDirty: () => {},
    audioTextRunner: { run: () => { throw new Error('must not probe during this test'); } },
    splitSquashedTitle, audioMetaEntry, audioMetaValid, probeAudioText,
    requests: { matchLibrary: () => {} }, warmAudioArtwork: () => {}, notifyClients: () => {}, queueAllSpriteGen: () => {}, setTimeout: () => {},
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

test('identity relocation during persistence keeps the previous catalog and scan status', async () => {
  const s = scanner(); await s.scan();
  const before = s.c.libraryCache, state = s.c.libraryScanState, indexes = s.c.fileIndex;
  s.dirs.set('/rootA', ['New.mp4']);
  s.c.mediaIdentity.persist = async () => { s.c.mediaIdentity.revision++; };
  await assert.rejects(s.scan(), {code:'EIDENTITYRACE'});
  assert.equal(s.c.libraryCache, before);
  assert.equal(s.c.fileIndex, indexes);
  assert.equal(s.c.libraryScanState, state);
});

test('manual refresh waits for an older inventory pass then starts a fresh one', async () => {
  let finishPrevious; const previous = new Promise(resolve => {finishPrevious = resolve;});
  const calls = [], c = {rescanPromise:previous, rescanLibraryAsync:async trigger=>{calls.push(trigger);return[];},
    fileIndex:{},probeCache:{},subProbeCache:{},markDirty(){},saveMediaInfo(){}};
  vm.createContext(c);
  const start = source.indexOf('  scan: async () => {', source.indexOf('const libraryRefresh ='));
  const end = source.indexOf('  enrich:', start);
  const scan = vm.runInContext('({' + source.slice(start,end) + '}).scan',c);
  const result = scan(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls, []);
  finishPrevious(); await result;
  assert.deepEqual(calls, ['manual-scan']);
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
  const code = source.slice(source.indexOf('function eligibleContainerFiles('), source.indexOf('const conversionReview ='));
  const c = { scanLibrary: () => [{ _filePath: '/large.mkv', fileSize: 200 }, { _filePath: '/small.mkv', fileSize: 10 }],
    audioTracksCache: {}, probeCache: {}, pixFmtCache: {}, audioProbeCache: {}, subProbeCache: {}, isAudioFile, selectAudioTrack,
    fs: { statSync: () => { throw new Error('Must not stat files while sorting'); } }, classifyFile: () => ({ tier: 'container', hasImageSubs: false }) };
  vm.createContext(c); vm.runInContext(code, c);
  assert.deepEqual(Array.from(vm.runInContext('eligibleContainerFiles({tiers:{container:true}})', c)), ['/small.mkv', '/large.mkv']);
});

test('mixed and audio sections index native audio independently of canonical episode/movie kind', async () => {
  const s = scanner();
  s.c.config.folders[0] = { path: '/rootA', type: 'custom-anime', label: 'Anime', mediaKind: 'mixed' };
  s.c.config.folders[1] = { path: '/rootB', type: 'custom-podcasts', label: 'Podcasts', mediaKind: 'audio' };
  s.dirs.set('/rootA', ['Film.mp4', 'Track.MP3', 'Series/']);
  s.dirs.set('/rootA/Series', ['Example.S01E02.mkv', 'notes.txt']);
  s.dirs.set('/rootB', ['Talk.wav', 'NotAnAudioFile.mp4']);
  s.c.getStreamMode = file => { assert.equal(isAudioFile(file), false, 'audio must skip video stream-mode probing'); return 'remux'; };
  s.c.embeddedTracks = id => { assert.equal(isAudioFile(id), false, 'audio must skip embedded video subtitle work'); return []; };
  await s.scan();
  const files = new Map(s.c.libraryCache.map(item => [item.filename, item]));
  assert.equal(files.size, 4);
  assert.equal(files.has('NotAnAudioFile.mp4'), false);
  assert.equal(files.get('Film.mp4').mediaKind, 'movie');
  assert.equal(files.get('Example.S01E02.mkv').mediaKind, 'show');
  assert.equal(files.get('Example.S01E02.mkv').type, 'custom-anime');
  assert.equal(files.get('Example.S01E02.mkv').showName, 'Series');
  assert.equal(files.get('Example.S01E02.mkv').epInfo.episode, 2);
  assert.equal(files.get('Track.MP3').mediaKind, 'audio');
  assert.equal(files.get('Talk.wav').streamMode, 'direct');
  assert.equal(files.get('Track.MP3').sectionId, sectionId('/rootA'));
  assert.equal(files.get('Talk.wav').sectionId, sectionId('/rootB'));
});

test('native audio never becomes eligible for the video conversion queue even with stale video cache data', () => {
  const code = source.slice(source.indexOf('function eligibleContainerFiles('), source.indexOf('const conversionReview ='));
  const c = { scanLibrary: () => [{ _filePath: '/podcast.mp3', mediaKind: 'audio' }, { _filePath: '/track.flac' },
      { _filePath: '/book.AAX', mediaKind: 'movie' }, { _filePath: '/book.M4B', mediaKind: 'show' }],
    isAudioFile, audioTracksCache: {}, probeCache: {}, pixFmtCache: {}, audioProbeCache: {}, subProbeCache: {},
    classifyFile: () => { throw new Error('audio must never reach the video converter classifier'); } };
  vm.createContext(c); vm.runInContext(code, c);
  assert.equal(vm.runInContext('eligibleContainerFiles({tiers:{container:true,audio:true,legacy:true,video:true}})', c).length, 0);
});

test('an audiobook section counts protected Audible files while separating playable M4B from unsupported audio', async () => {
  const s = scanner();
  s.c.config.folders = [{ path: '/rootA', type: 'custom-audio-books', label: 'Audio Books', mediaKind: 'audio' }];
  s.dirs.set('/rootA', ['Book.AAX', 'Other.aa', 'More.aaxc', 'Playable.M4B', 'Film.mp4']);
  s.c.getStreamMode = () => { throw new Error('audiobooks must skip video stream probing'); };
  s.c.embeddedTracks = () => { throw new Error('audiobooks must skip video subtitle probing'); };
  await s.scan();
  assert.equal(s.c.libraryCache.length, 4);
  const audible = s.c.libraryCache.filter(item => item.playbackIssue);
  assert.equal(audible.length, 3);
  for (const item of audible) {
    assert.equal(item.mediaKind, 'audio'); assert.equal(item.type, 'custom-audio-books');
    assert.equal(item.folder, 'Audio Books'); assert.equal(item.streamMode, 'unsupported');
    assert.equal(item.videoUrl, null); assert.equal(item.codec, null);
  }
  const playable = s.c.libraryCache.find(item => item.filename === 'Playable.M4B');
  assert.equal(playable.streamMode, 'direct'); assert.equal(playable.playbackIssue, null);
  assert.match(playable.videoUrl, /^\/stream\//);
});

test('a visible playback issue change updates the library revision', () => {
  const before = { id: 'book', mediaKind: 'audio', streamMode: 'unsupported', playbackIssue: null };
  assert.equal(libraryChanged([before], [{ ...before, playbackIssue: 'Protected Audible file' }]), true);
});

for (const { stopped, failedScan } of [
  { stopped: false, failedScan: false },
  { stopped: true, failedScan: false },
  { stopped: false, failedScan: true },
]) {
  test(`final conversion refresh indexes a verified replacement after ${stopped ? 'stop' : 'finish'}${failedScan ? ' despite an earlier scan failure' : ''}`, { timeout: 1000 }, async () => {
    const s = scanner();
    const oldPath = '/rootA/A.mkv', newPath = '/rootA/A.mp4';
    const pendingPath = '/rootB/Unfinished.mkv';
    s.c.SUPPORTED_EXT.push('.mkv');
    s.dirs.set('/rootA', ['A.mkv']);
    s.dirs.set('/rootB', stopped ? ['Unfinished.mkv'] : []);
    await s.scan();

    const reader = source.slice(source.indexOf('function invalidateLibrary('), source.indexOf('let libraryVersion ='));
    const singleFlight = source.slice(source.indexOf('let rescanPromise ='), source.indexOf('async function doRescan('));
    const eligible = source.slice(source.indexOf('function eligibleContainerFiles('), source.indexOf('const conversionReview ='));
    s.c.classifyFile = require('./conversion-plan').classifyFile;
    s.c.pixFmtCache = {}; s.c.audioProbeCache = {};
    s.c.conversionWorker = { invalidateOriginals() {} };
    vm.runInContext(reader + singleFlight + eligible, s.c);
    const queueStart = source.indexOf('const conversionQueue =');
    const hookStart = source.indexOf('  onFileComplete:', queueStart);
    const hookEnd = source.indexOf('  log:', hookStart);
    assert.ok(hookStart > queueStart && hookEnd > hookStart, 'extract the production conversion refresh hooks');
    const hooks = vm.runInContext('({' + source.slice(hookStart, hookEnd) + '})', s.c);

    let releaseScan, scanEntered;
    const scanGate = new Promise(resolve => { releaseScan = resolve; });
    const listedOldFile = new Promise(resolve => { scanEntered = resolve; });
    s.c.fs.promises.stat = async file => {
      if (file === oldPath) {
        scanEntered(); await scanGate;
        throw Object.assign(new Error('source renamed during scan'), { code: 'ENOENT' });
      }
      return { size: 100, mtimeMs: 1000 };
    };
    const scans = [];
    s.c.recordScan = scan => scans.push(scan.trigger);
    if (failedScan) {
      let failOnce = true;
      s.c.saveLibraryCache = () => {
        if (failOnce) { failOnce = false; throw new Error('earlier scan save failed'); }
      };
    }
    const priorScan = vm.runInContext('rescanLibraryAsync("earlier-conversion")', s.c);
    await listedOldFile;

    const calls = [];
    const queue = require('./conversion-queue')({
      worker: {
        convertCompatible: async file => {
          calls.push(file);
          s.dirs.set('/rootA', ['A.mp4']);
          delete s.c.probeCache[oldPath];
          s.c.probeCache[newPath] = 'h264'; s.c.pixFmtCache[newPath] = 'yuv420p';
          s.c.audioProbeCache[newPath] = 'aac'; s.c.audioTracksCache[newPath] = [{ channels: 2 }];
          return { ok: true, filePath: file, newPath };
        },
        killActive: () => false,
      },
      getConfig: () => ({ enabled: true, retainOriginals: false, maxFilesPerRun: 1 }),
      getFingerprint: async () => ({dev:1,ino:1,size:100,mtimeMs:1000,ctimeMs:1000}),
      getEligibleFiles: () => stopped ? [oldPath, pendingPath] : [oldPath],
      isPlaybackActive: () => false,
      onFileComplete: result => { hooks.onFileComplete(result); if (stopped) queue.stop(); },
      onBatchComplete: hooks.onBatchComplete,
    });
    await queue.start({ all: true });
    for (let attempt=0;attempt<20 && queue.status!=='idle';attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.status, 'idle');
    assert.equal(queue.snapshot().converted, 1);
    assert.deepEqual(calls, [oldPath], 'a stopped queue must not start the next source');
    assert.deepEqual(scans, [], 'final refresh must wait for the scan that predates the rename');

    releaseScan();
    if (failedScan) await assert.rejects(priorScan, /earlier scan save failed/);
    else await priorScan;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(s.c.libraryCache.some(item => item._filePath === newPath));
    assert.ok(!s.c.libraryCache.some(item => item._filePath === oldPath));
    assert.equal(s.c.fileIndex[newPath], newPath);
    assert.equal(s.c.fileIndex[oldPath], undefined);
    assert.equal(scans.at(-1), 'conversion-queue');
    assert.equal(s.reads.get('/rootA'), 3, 'initial, earlier, and fresh final scans use separate directory listings');

    if (stopped) {
      s.c.probeCache[pendingPath] = 'h264';
      s.c.audioProbeCache[pendingPath] = 'aac'; s.c.audioTracksCache[pendingPath] = [{ channels: 2 }];
    }
    const remaining = vm.runInContext('eligibleContainerFiles({tiers:{container:true,audio:true,legacy:true,video:true}})', s.c);
    assert.deepEqual(Array.from(remaining), stopped ? [pendingPath] : [], 'a fresh run excludes the converted file');
  });
}
