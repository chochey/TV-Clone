const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createProbe = require('./probe');
const selection = require('./audio-track-selection');
const media = require('./library-media');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function fixture(streams) {
  const file = '/private/library/episode.mp4';
  let probes = 0;
  const probe = createProbe({ DATA_DIR: '/synthetic-nonexistent-audio-playback',
    loadJSON: (_file, fallback) => structuredClone(fallback), saveJSON() {},
    runner: { run: async () => { probes++; return { stdout: JSON.stringify({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', height: 1080 },
      ...streams,
    ] }) }; } } });
  // Simulate a library scanned before disposition metadata was introduced.
  probe.probeCache[file] = 'h264';
  probe.audioProbeCache[file] = 'aac';
  probe.audioTracksCache[file] = [{ index: 1, codec: 'aac', lang: 'rus' }];
  const item = { id: 'episode', title: 'Episode', mediaKind: 'show', _filePath: file,
    folderPath: '/private/library', streamMode: 'direct', audioTracks: [{ index: 1 }], subtitles: [] };
  let handler;
  require('./routes/library')({ get(route, _auth, fn) { if (route === '/api/item/:id') handler = fn; }, post() {}, put() {} }, {
    ...probe, requireAuth() {},
    scanLibrary: () => [item], getMetadataForItem: () => null,
    getRequestProfile: req => req.denied ? null : 'viewer',
    loadProfileData: () => ({ progress: {}, watched: {} }), fileIndex: () => ({ episode: file }),
    probeSubtitlesAsync: async () => [] });
  return { probe, probes: () => probes, async request(extra = {}) {
    const res = { code: 200, status(value) { this.code = value; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: 'episode' }, ...extra }, res);
    return res;
  } };
}

test('detail refreshes stale audio data before declaring English selection and HLS routing', async () => {
  const f = fixture([
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'rus' }, disposition: { default: 1 } },
    { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng', handler_name: 'Commentary' } },
    { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'English' } },
  ]);
  const response = await f.request();
  assert.equal(response.code, 200);
  assert.equal(response.body.defaultAudioTrack, 3);
  assert.equal(response.body.streamMode, 'remux', 'cached direct MP4 decision must be corrected');
  assert.equal(response.body.audioTracks.length, 3);
  assert.equal(response.body.audioTracks[2].isDefault, true);
  assert.match(response.body.audioTracks[2].label, /^English/);
  assert.ok(!JSON.stringify(response.body).includes('/private'));
  await f.request();
  assert.equal(f.probes(), 1, 'fresh disposition metadata must be reused');
});

test('single English track remains direct and index zero is returned without loss', async () => {
  const f = fixture([{ index: 0, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'en-US' } }]);
  const response = await f.request();
  assert.equal(response.body.defaultAudioTrack, 0);
  assert.equal(response.body.streamMode, 'direct');
});

test('detail profile authorization happens before any new audio probe', async () => {
  const f = fixture([]);
  assert.equal((await f.request({ denied: true })).code, 403);
  assert.equal(f.probes(), 0);
});

test('conversion plan and queue eligibility follow preferred English codec and channels', async () => {
  const file = '/private/library/episode.mp4';
  let handler;
  const c = { ...selection, ...media, ...require('./conversion-plan'), require,
    app: { get(_route, _auth, fn) { handler = fn; } }, requireAdminSession() {}, requirePermission: () => () => {},
    scanLibrary: () => [{ _filePath: file, fileSize: 1000 }],
    probeCache: { [file]: 'h264' }, pixFmtCache: { [file]: 'yuv420p' },
    audioProbeCache: { [file]: 'aac' }, subProbeCache: {},
    audioTracksCache: { [file]: [
      { index: 1, lang: 'rus', codec: 'aac', channels: 2, default: true },
      { index: 2, lang: 'eng', codec: 'eac3', channels: 6 },
    ] },
    conversionConfig: { get: () => ({ tiers: { audio: true }, retainedBudgetGB: 1 }) },
    storageHealth: { snapshot: async () => ({ pool: { avail: 1e9 } }) },
    conversionStorage: { snapshot: async () => ({ warnings: [] }) } };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function eligibleContainerFiles('), source.indexOf('const conversionReview =')), c);
  vm.runInContext(source.slice(source.indexOf("app.get('/api/conversion/plan'"), source.indexOf('// ── Library conversion, phase 3')), c);
  const request = () => new Promise(resolve => {
    const res = { code: 200, status(value) { this.code = value; return this; }, json(body) { this.body = body; resolve(this); } };
    handler({ query: {} }, res);
  });
  const needed = await request();
  assert.equal(needed.code, 200);
  assert.equal(needed.body.plan.tiers.audio.count, 1);
  assert.equal(needed.body.eligibleSelected, 1);
  assert.ok(!JSON.stringify(needed.body).includes('/private'));
  c.audioTracksCache[file][0].lang = 'eng';
  c.audioTracksCache[file][1].lang = 'rus';
  const compatible = await request();
  assert.equal(compatible.body.plan.tiers.audio.count, 0);
  assert.equal(compatible.body.eligibleSelected, 0, 'a foreign surround track must not force conversion of English stereo');
});
