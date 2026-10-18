import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackReport } from './playback-report.js';

function clock() { let t = 0; return { now: () => t, at: ms => { t = ms; } }; }
const finish = r => r.finish({ itemId: 'heat', direct: false, playbackId: 'p', quality: 'auto' });

test('start-up time runs from opening to the first frame, and watch time only counts playing', () => {
  const c = clock(); const r = createPlaybackReport({ now: c.now });
  c.at(2500); r.playing();
  c.at(62500); r.paused();
  c.at(90000); r.playing();
  c.at(120000);
  assert.deepEqual(finish(r), { itemId: 'heat', direct: false, playbackId: 'p', quality: 'auto',
    startupMs: 2500, rebuffers: 0, rebufferMs: 0, seekWaitMs: 0, watchedMs: 90000, failed: false });
});

test('a stall while playing is a rebuffer; waiting right after a seek is not', () => {
  const c = clock(); const r = createPlaybackReport({ now: c.now });
  c.at(1000); r.playing();
  c.at(10000); r.waiting();
  c.at(13000); r.playing();             // 3 s stall
  c.at(20000); r.seeking(); r.waiting();
  c.at(22000); r.playing();             // 2 s seek wait
  c.at(30000); r.waiting();
  c.at(31000); r.playing();             // 1 s stall
  c.at(40000);
  const out = finish(r);
  assert.deepEqual([out.rebuffers, out.rebufferMs, out.seekWaitMs], [2, 4000, 2000]);
  assert.equal(out.watchedMs, 33000);
});

test('waiting before the first frame is start-up, and a start that never plays is a failure', () => {
  const c = clock(); const r = createPlaybackReport({ now: c.now });
  r.waiting(); c.at(4000); r.playing(); c.at(5000);
  assert.deepEqual([finish(r).startupMs, finish(r).rebuffers], [4000, 0]);
  const f = createPlaybackReport({ now: c.now }); c.at(35000); f.failed();
  const out = finish(f);
  assert.equal(out.failed, true);
  assert.equal(out.startupMs, 30000);
});

test('a short look or a closed player before anything happened is not worth sending', () => {
  const c = clock(); const r = createPlaybackReport({ now: c.now });
  c.at(1000); r.playing(); c.at(3000);
  assert.equal(r.worthSending(), false);
  c.at(9000);
  assert.equal(r.worthSending(), true);
  const f = createPlaybackReport({ now: c.now }); f.failed();
  assert.equal(f.worthSending(), true);
});
