import test from 'node:test';
import assert from 'node:assert/strict';
import { createTapGestures, DOUBLE_TAP_MS } from './tap-gestures.js';

function harness() {
  let clock = 1000; const timers = new Map(); let nextId = 1; const events = [];
  const gestures = createTapGestures({
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: id => timers.delete(id),
    onSingle: () => events.push('single'), onDouble: side => events.push(`double:${side}`),
  });
  const advance = ms => { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); } };
  const tap = (x, width = 1000, pointerType = 'touch') => gestures.pointerUp({ pointerType, clientX: x }, width);
  return { gestures, events, advance, tap };
}

test('one tap toggles after the double-tap window passes', () => {
  const h = harness();
  h.tap(100);
  assert.deepEqual(h.events, []);
  h.advance(DOUBLE_TAP_MS);
  assert.deepEqual(h.events, ['single']);
});

test('two quick taps seek by side and cancel the pending single tap', () => {
  const h = harness();
  h.tap(900); h.advance(100); h.tap(900);
  h.tap(100); h.advance(100); h.tap(100);
  h.advance(1000);
  assert.deepEqual(h.events, ['double:right', 'double:left']);
});

test('a mouse is not a touch, and clicks just after a touch are flagged as synthetic', () => {
  const h = harness();
  h.tap(100, 1000, 'mouse');
  h.advance(1000);
  assert.deepEqual(h.events, []);
  assert.equal(h.gestures.touchedRecently(), false);
  h.tap(100);
  assert.equal(h.gestures.touchedRecently(), true);
  h.advance(600);
  assert.equal(h.gestures.touchedRecently(), false);
  h.gestures.stop();
});
