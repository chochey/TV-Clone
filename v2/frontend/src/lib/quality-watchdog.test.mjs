import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualityWatchdog, QUALITY_WINDOW_MS, QUALITY_GRACE_MS } from './quality-watchdog.js';

// Simulates the player: frames presented per second, decoder counters, a check once a second.
function harness() {
  let clock = 0;
  const w = createQualityWatchdog({ now: () => clock });
  const decoder = { dropped: 0, total: 0 };
  const playing = { active: true, playbackRate: 1, readyState: 4, hidden: false, countsFrames: true };
  function second({ fps = 24, dropped = 0, state = {} } = {}) {
    clock += 1000;
    for (let i = 0; i < fps; i++) w.frame();
    decoder.total += fps + dropped; decoder.dropped += dropped;
    return w.check({ ...playing, ...state, quality: { ...decoder } });
  }
  return { w, second, run(n, opts) { const out = []; for (let i = 0; i < n; i++) out.push(second(opts)); return out.filter(r => r.action !== 'none'); } };
}

test('smooth playback is never demoted', () => {
  const h = harness(); h.w.start();
  assert.deepEqual(h.run(120), []);
});

test('sustained starvation demotes after three bad windows, past the start-up grace', () => {
  const h = harness(); h.w.start();
  const result = h.run((QUALITY_GRACE_MS + 4 * QUALITY_WINDOW_MS) / 1000, { fps: 8 });
  assert.equal(result.length, 1); assert.equal(result[0].action, 'demote'); assert.match(result[0].reason, /fps reaching the screen/);
});

test('heavy dropping demotes even when frames still arrive', () => {
  const h = harness(); h.w.start();
  const result = h.run((QUALITY_GRACE_MS + 4 * QUALITY_WINDOW_MS) / 1000, { fps: 24, dropped: 10 });
  assert.equal(result[0]?.action, 'demote'); assert.match(result[0].reason, /% of frames dropped/);
});

test('a short bad patch that recovers is forgiven', () => {
  const h = harness(); h.w.start();
  h.run(QUALITY_GRACE_MS / 1000);
  assert.deepEqual(h.run(2 * QUALITY_WINDOW_MS / 1000, { fps: 8 }), []);
  assert.deepEqual(h.run(QUALITY_WINDOW_MS / 1000), []);
  assert.deepEqual(h.run(2 * QUALITY_WINDOW_MS / 1000, { fps: 8 }), [], 'the count started over after the good window');
});

test('time in a background tab is not judged, nor counted against the next window', () => {
  const h = harness(); h.w.start();
  h.run(QUALITY_GRACE_MS / 1000 + 6);
  // Browsers throttle hidden players: few frames presented, many counted as dropped.
  assert.deepEqual(h.run(300, { fps: 1, dropped: 23, state: { hidden: true } }), []);
  assert.deepEqual(h.run(3 * QUALITY_WINDOW_MS / 1000), [], 'back in view and playing smoothly');
});

test('buffering, other speeds and inactive playback are not judged', () => {
  const h = harness(); h.w.start();
  assert.deepEqual(h.run(60, { fps: 0, state: { readyState: 2 } }), []);
  assert.deepEqual(h.run(60, { fps: 8, state: { playbackRate: 1.5 } }), []);
  assert.deepEqual(h.run(60, { fps: 8, state: { active: false } }), []);
});

test('without a frame counter only the decoder\'s own drop count can demote', () => {
  const h = harness(); h.w.start();
  assert.deepEqual(h.run(60, { fps: 0, state: { countsFrames: false } }), []);
});

// Firefox resumes a backgrounded video behind the sound; the catch-up after a return must never
// count toward switching the browser off passthrough for good.
test('returning to the tab gives the same grace as a new session', () => {
  const h = harness(); h.w.start();
  h.run(Math.ceil(QUALITY_GRACE_MS / 1000) + 12);             // settled, smooth
  h.second({ state: { hidden: true } });
  h.w.resume();
  assert.deepEqual(h.run(Math.floor(QUALITY_GRACE_MS / 1000) - 1, { fps: 5 }), [], 'nothing judged during the grace');
  assert.deepEqual(h.run(QUALITY_WINDOW_MS / 1000 * 2), [], 'and the smooth playback after it is fine');
});
