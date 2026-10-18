const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./skip-segments');

const library = [
  { id: 'e1', type: 'show', mediaKind: 'show', showName: 'Show A', epInfo: { season: 1, episode: 1 }, filename: 'a1.mkv' },
  { id: 'e2', type: 'show', mediaKind: 'show', showName: 'Show A', epInfo: { season: 1, episode: 2 }, filename: 'a2.mkv' },
  { id: 'b1', type: 'show', mediaKind: 'show', showName: 'Show B', epInfo: { season: 2, episode: 5 }, filename: 'b1.mkv' },
  { id: 'book', mediaKind: 'audio', showName: 'Show A', filename: 'book.m4b' },
];
function fixture({ segments = {}, introdb = null, detect = async () => ({ start: 30, end: 90 }) } = {}) {
  const routes = new Map(); let saves = 0; const introCalls = [];
  const app = Object.fromEntries(['get', 'post', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const api = register(app, { requireAuth() {}, skipSegments: segments, save: () => saves++, scanLibrary: () => library,
    getMetadataForItem: item => (item.showName === 'Show B' ? { imdbID: 'tt0001' } : null), isAudioFile: f => /\.m4b$/.test(f || ''),
    waitForTranscodeIdle: async () => {}, log() {}, warn() {},
    introDetect: { fetchIntroDb: async (...args) => { introCalls.push(args); return introdb; }, detectIntroForShow: detect } });
  async function call(method, id, body = {}) {
    const res = { json(v) { this.body = v; return this; } };
    await routes.get(`${method} /api/skip-segments/:id`).at(-1)({ params: { id }, body }, res);
    return res.body;
  }
  return { call, api, segments, introCalls, get saves() { return saves; } };
}

test('an episode entry wins over the show entry, which wins over IntroDB', async () => {
  const f = fixture({ segments: { e1: { intro: { start: 1, end: 2 } }, 'show:Show A': { intro: { start: 5, end: 9 } } },
    introdb: { intro: { start_sec: 10, end_sec: 70 }, outro: { start_sec: 1200, end_sec: 1260 } } });
  assert.deepEqual(await f.call('get', 'e1'), { intro: { start: 1, end: 2 } });
  assert.deepEqual(await f.call('get', 'e2'), { intro: { start: 5, end: 9 } });
  assert.deepEqual(await f.call('get', 'b1'), { intro: { start: 10, end: 70 }, outro: { start: 1200, end: 1260 }, source: 'introdb' });
  assert.deepEqual(f.introCalls, [['tt0001', 2, 5]]);
  assert.deepEqual(await f.call('get', 'unknown'), {});
});

test('saving applies to the episode or the whole show, keeps only valid ranges, and deleting removes it', async () => {
  const f = fixture();
  await f.call('post', 'e1', { intro: { start: 3, end: 40 }, outro: { start: 'bad' } });
  assert.deepEqual(f.segments.e1, { intro: { start: 3, end: 40 } });
  await f.call('post', 'e2', { intro: { start: 4, end: 41 }, applyToShow: true });
  assert.deepEqual(f.segments['show:Show A'], { intro: { start: 4, end: 41 } });
  await f.call('delete', 'e1');
  assert.equal(f.segments.e1, undefined);
  assert.equal(f.saves, 3);
});

test('background detection covers shows with two or more episodes and no entry yet, never audiobooks', async () => {
  const detected = [];
  const f = fixture({ segments: { 'show:Show C': { intro: {} } }, detect: async name => { detected.push(name); return { start: 30, end: 90 }; } });
  await f.api.backgroundDetectIntros(library);
  assert.deepEqual(detected, ['Show A']);
  assert.deepEqual(f.segments['show:Show A'], { intro: { start: 30, end: 90 } });
});

test('detecting an intro on demand saves it for the whole show', async () => {
  const routes = new Map(); let saves = 0; const segments = {};
  const app = Object.fromEntries(['get', 'post', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  register(app, { requireAuth() {}, skipSegments: segments, save: () => saves++, scanLibrary: () => library,
    getMetadataForItem: () => null, isAudioFile: () => false, waitForTranscodeIdle: async () => {}, log() {}, warn() {},
    introDetect: { fetchIntroDb: async () => null, detectIntroForShow: async name => (name === 'Show A' ? { start: 30, end: 90 } : null) } });
  const call = async id => { const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
    await routes.get('post /api/detect-intro/:id').at(-1)({ params: { id } }, res); return res; };
  assert.deepEqual((await call('e1')).body, { ok: true, intro: { start: 30, end: 90 }, showName: 'Show A' });
  assert.deepEqual(segments['show:Show A'], { intro: { start: 30, end: 90 } });
  assert.equal(saves, 1);
  assert.deepEqual((await call('b1')).body, { ok: false, message: 'Could not detect intro pattern' });
  assert.equal((await call('nope')).statusCode, 400);
});
