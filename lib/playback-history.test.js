const test = require('node:test');
const assert = require('node:assert/strict');
const createPlaybackHistory = require('./playback-history');

const DAY = 86400000;
function fixture(start = Date.parse('2026-10-18T20:00:00Z')) {
  let clock = start; const store = {};
  const h = createPlaybackHistory({ dataDir: '/data', loadJSON: (f, fb) => store[f] ?? fb, saveJSON: (f, v) => { store[f] = JSON.parse(JSON.stringify(v)); },
    now: () => clock, saveDelayMs: 0 });
  return { h, store, advance: ms => { clock += ms; } };
}
const who = { profileId: 'p1', profileName: 'Ann', title: 'Heat' };
const play = (extra = {}) => ({ itemId: 'heat', direct: false, playbackId: 'a'.repeat(32), quality: 'auto', startupMs: 2000, rebuffers: 0, rebufferMs: 0, seekWaitMs: 0, watchedMs: 600000, ...extra });

test('a report records the delivery the server used for that stream, and clamps nonsense', () => {
  const f = fixture();
  f.h.noteSession('a'.repeat(32), { delivery: 'transcode-gpu', quality: 'auto' });
  const e = f.h.record(play({ startupMs: 1e12, rebuffers: -3, watchedMs: 'x' }), who);
  assert.equal(e, null, 'no watch time and no failure is not worth keeping');
  const ok = f.h.record(play({ startupMs: 1e12, rebuffers: -3 }), who);
  assert.deepEqual({ ...ok, at: 0 }, { at: 0, itemId: 'heat', title: 'Heat', profile: 'Ann', delivery: 'transcode-gpu', quality: 'auto',
    startupMs: 600000, rebuffers: 0, rebufferMs: 0, seekWaitMs: 0, watchedMs: 600000, failed: false });
});

test('direct play is recorded as direct, an unknown stream as unknown, and a failed start is kept', () => {
  const f = fixture();
  assert.equal(f.h.record(play({ direct: true, playbackId: null }), who).delivery, 'direct');
  assert.equal(f.h.record(play({ playbackId: 'b'.repeat(32) }), who).delivery, 'unknown');
  const failed = f.h.record(play({ failed: true, watchedMs: 0, startupMs: 30000 }), who);
  assert.equal(failed.failed, true);
});

test('the summary covers the chosen days: plays, delivery and quality mix, start-up and rebuffering', () => {
  const f = fixture();
  f.h.noteSession('a'.repeat(32), { delivery: 'transcode-gpu' });
  f.h.record(play({ startupMs: 1000, watchedMs: 3600000 }), who);
  f.h.record(play({ startupMs: 3000, watchedMs: 1800000, rebuffers: 4, rebufferMs: 36000 }), { ...who, title: 'Heat' });
  f.h.record(play({ itemId: 'col', direct: true, playbackId: null, startupMs: 500, watchedMs: 1200000, quality: 'auto' }), { ...who, title: 'Collateral' });
  f.h.record(play({ failed: true, watchedMs: 0, startupMs: 30000 }), who);
  f.advance(-40 * DAY);
  f.h.record(play({ watchedMs: 999999 }), who); // too old for a 30-day summary
  f.advance(40 * DAY);
  const s = f.h.summary({ days: 30 });
  assert.equal(s.plays, 4);
  assert.equal(s.failed, 1);
  assert.equal(s.hoursWatched, 1.83);
  assert.deepEqual(s.byDelivery, { 'transcode-gpu': 3, direct: 1 });
  assert.deepEqual(s.byQuality, { auto: 4 });
  assert.deepEqual(s.startup, { median: 1000, p90: 3000 });
  assert.equal(s.rebufferRatio, 0.0055);
  assert.equal(s.playsWithRebuffer, 1);
  assert.deepEqual(s.worst, [{ itemId: 'heat', title: 'Heat', plays: 3, rebuffers: 4, rebufferSec: 36 }]);
  assert.equal(s.daily.length, 30);
  assert.deepEqual(s.daily.at(-1), { day: '2026-10-18', plays: 4, watchedMin: 110, rebufferSec: 36 });
});

test('history is saved, capped, and old plays are dropped', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.h.record(play(), who);
  assert.equal(f.store['/data/playback-history.json'].plays.length, 5);
  const small = createPlaybackHistory({ dataDir: '/d', loadJSON: (fl, fb) => fb, saveJSON() {}, now: () => Date.now(), maxEntries: 3, saveDelayMs: 0 });
  for (let i = 0; i < 5; i++) small.record(play({ watchedMs: 10000 + i }), who);
  assert.deepEqual(small.summary({ days: 1 }).plays, 3);
});
