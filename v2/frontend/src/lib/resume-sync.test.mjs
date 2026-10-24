// Firefox stops decoding a hidden tab's video after 10 s and keeps the sound; on return the
// picture resumes behind the sound and, with this library's 10-bit HEVC, stays behind until a
// refresh. The player compares each presented frame with the playback clock after a return and
// first jumps in place, then rebuilds the stream, the way a refresh does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResumeSync } from './resume-sync.js';

// A check once a second; `lag` is how far the picture trails the clock, `fps` frames per second.
function harness() {
  const s = createResumeSync();
  let ct = 0;
  function second({ lag = 0, fps = 24, playing = true, advance = 1 } = {}) {
    if (playing) ct += advance;
    for (let i = 0; i < fps; i++) s.frame(ct - lag, ct);
    return s.check({ playing, currentTime: ct }).action;
  }
  const run = (n, opts) => Array.from({ length: n }, () => second(opts));
  return { s, second, run };
}

test('before any tab switch nothing is judged, however far behind the picture is', () => {
  const h = harness();
  assert.deepEqual(h.run(20, { lag: 3 }).filter(a => a !== 'none'), []);
});

test('after a return, a picture that stays behind is jumped in place, then rebuilt, then left alone', () => {
  const h = harness();
  h.s.hidden(); h.s.shown();
  const actions = h.run(20, { lag: 2 });
  const fired = actions.map((a, i) => [i, a]).filter(([, a]) => a !== 'none');
  assert.deepEqual(fired.map(([, a]) => a), ['resync', 'rebuild']);
  assert.ok(fired[0][0] >= 2 && fired[0][0] <= 5, `resync after the settle period, at check ${fired[0][0]}`);
  assert.ok(fired[1][0] - fired[0][0] >= 3, 'the rebuild waits to see whether the jump worked');
});

test('a picture that keeps up after a return is never touched, and the watch ends', () => {
  const h = harness();
  h.s.hidden(); h.s.shown();
  assert.deepEqual(h.run(30, { lag: 0.05 }).filter(a => a !== 'none'), []);
  assert.deepEqual(h.run(10, { lag: 3 }).filter(a => a !== 'none'), [], 'the watch has ended by now');
});

test('when the jump fixes it there is no rebuild', () => {
  const h = harness();
  h.s.hidden(); h.s.shown();
  const first = h.run(6, { lag: 2 });
  assert.ok(first.includes('resync'));
  assert.deepEqual(h.run(20, { lag: 0.04 }).filter(a => a !== 'none'), []);
});

test('a starved picture with the sound still moving counts as behind', () => {
  const h = harness();
  h.s.hidden(); h.s.shown();
  const actions = h.run(8, { fps: 3, lag: 0 });
  assert.ok(actions.includes('resync'));
});

test('time spent paused or buffering after the return does not count, so a late start is still watched', () => {
  const h = harness();
  h.s.hidden(); h.s.shown();
  assert.deepEqual(h.run(30, { playing: false, fps: 0 }).filter(a => a !== 'none'), []);
  assert.ok(h.run(8, { lag: 2 }).includes('resync'), 'the watch counts only time spent playing');
});

test('hiding the tab again cancels the watch until the next return', () => {
  const h = harness();
  h.s.hidden(); h.s.shown();
  h.run(1, { lag: 2 });
  h.s.hidden();
  assert.deepEqual(h.run(10, { lag: 2 }).filter(a => a !== 'none'), []);
});
