import test from 'node:test';
import assert from 'node:assert/strict';
import { createStallWatchdog, STALL_AFTER_MS, RESUME_GRACE_MS } from './stall-watchdog.js';

// Drives the watchdog once a second, like the player's interval.
function harness(start = 0) {
  let clock = start;
  const watchdog = createStallWatchdog({ now: () => clock });
  const playing = { active: true, hidden: false, position: 100, aheadTarget: -1, passthrough: true, direct: false };
  return { watchdog, playing, tick(state, seconds = 1) { const out = []; for (let i = 0; i < seconds; i++) { clock += 1000; out.push(watchdog.check(state).action); } return out; } };
}
const actions = list => list.filter(action => action !== 'none');

test('steady playback never triggers anything', () => {
  const h = harness();
  for (let i = 0; i < 30; i++) { h.playing.position += 1; assert.equal(h.tick(h.playing)[0], 'none'); }
});

test('a hole with media buffered just ahead is hopped, then a stuck passthrough stream falls back', () => {
  const h = harness();
  h.tick(h.playing);                                    // first look
  const frozen = { ...h.playing, aheadTarget: 105 };
  assert.deepEqual(actions(h.tick(frozen, 3 * 4)), ['nudge', 'nudge', 'nudge', 'fallback'],
    'three hops over the gap, then the stream itself is the problem');
});

test('waiting for data rebuilds the same stream instead of abandoning passthrough', () => {
  const h = harness();
  h.tick(h.playing);
  assert.deepEqual(actions(h.tick(h.playing, 3 * 4)), ['rebuild'],
    'an empty buffer is the network or the session, not the decoder');
});

test('a hidden tab is never judged, and coming back gets a grace period', () => {
  const h = harness();
  h.tick(h.playing);
  assert.deepEqual(actions(h.tick({ ...h.playing, hidden: true }, 120)), [], 'browsers throttle hidden players');
  h.watchdog.reset(RESUME_GRACE_MS);                    // the tab became visible again
  assert.deepEqual(actions(h.tick(h.playing, RESUME_GRACE_MS / 1000)), [], 'catching up after a return is not a stall');
  assert.deepEqual(actions(h.tick(h.playing, 3 * 4)), ['rebuild'], 'a real freeze is still caught after the grace period');
});

test('pressing play after a pause gets the same grace while the buffer refills', () => {
  const h = harness();
  h.tick({ ...h.playing, active: false }, 600);          // paused for ten minutes
  h.watchdog.reset(RESUME_GRACE_MS);
  assert.deepEqual(actions(h.tick(h.playing, RESUME_GRACE_MS / 1000)), []);
  h.playing.position += 2; h.tick(h.playing);             // playback resumes
  assert.deepEqual(actions(h.tick({ ...h.playing, position: h.playing.position + 0.5 })), []);
});

test('a direct file is simply nudged to play again', () => {
  const h = harness();
  h.tick(h.playing);
  assert.deepEqual(actions(h.tick({ ...h.playing, direct: true, passthrough: false }, 3 * 4)), ['play']);
});

test('a transcode that stalls with media ahead is rebuilt, never "fallen back"', () => {
  const h = harness();
  h.tick(h.playing);
  assert.deepEqual(actions(h.tick({ ...h.playing, passthrough: false, aheadTarget: 103 }, 3 * 4)), ['nudge', 'nudge', 'nudge', 'rebuild']);
});

test('progress resets the count, so separate short hiccups never add up', () => {
  const h = harness();
  h.tick(h.playing);
  for (let round = 0; round < 5; round++) {
    assert.deepEqual(actions(h.tick(h.playing, 2)), []);  // frozen under STALL_AFTER_MS
    h.playing.position += 1;
    h.tick(h.playing);
  }
  assert.ok(STALL_AFTER_MS >= 3000);
});
