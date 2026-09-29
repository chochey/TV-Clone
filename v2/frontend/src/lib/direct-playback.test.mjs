import test from 'node:test';
import assert from 'node:assert/strict';
import { startDirectPlayback, directPlaybackError } from './direct-playback.js';

function fixture() {
  const events = new Map(), jobs = new Map();
  let id = 0, playCalls = 0, timedOut = 0, metadata = 0, current = true;
  const video = { paused: true, readyState: 0, currentTime: 0, pause() {},
    play() { playCalls++; return new Promise(() => {}); },
    addEventListener(key, fn) { events.set(key, fn); },
    removeEventListener(key, fn) { if (events.get(key) === fn) events.delete(key); },
  };
  const timers = { setTimeout(fn) { jobs.set(++id, fn); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const cancel = startDirectPlayback(video, '/stream/film', 120, {
    isCurrent: () => current, onMetadata() { metadata++; }, onTimeout() { timedOut++; }, onBlocked() {}, timers,
  });
  return { video, events, jobs, cancel, get playCalls() { return playCalls; }, get timedOut() { return timedOut; },
    get metadata() { return metadata; }, stale() { current = false; } };
}

test('direct loading requests autoplay and starts its timeout before metadata exists', () => {
  const f = fixture();
  assert.equal(f.video.src, '/stream/film'); assert.equal(f.playCalls, 1); assert.equal(f.metadata, 0);
  [...f.jobs.values()][0](); assert.equal(f.timedOut, 1);
});
test('metadata applies the resume point without delaying or repeating the autoplay request', () => {
  const f = fixture(); f.events.get('loadedmetadata')();
  assert.equal(f.video.currentTime, 120); assert.equal(f.metadata, 1); assert.equal(f.playCalls, 1); f.cancel();
});
test('teardown removes metadata and watchdog callbacks, including callbacks already queued', () => {
  const f = fixture(); const metadata = f.events.get('loadedmetadata'), timeout = [...f.jobs.values()][0];
  f.cancel(); metadata(); timeout();
  assert.equal(f.metadata, 0); assert.equal(f.video.currentTime, 0); assert.equal(f.timedOut, 0);
  assert.equal(f.events.size, 0); assert.equal(f.jobs.size, 0);
});
test('old direct sources cannot seek a replacement player after its generation changes', () => {
  const f = fixture(); f.stale(); f.events.get('loadedmetadata')();
  assert.equal(f.video.currentTime, 0); assert.equal(f.metadata, 0); f.cancel();
});
test('network and unsupported source errors explain a recoverable next action', () => {
  assert.match(directPlaybackError({ code: 2 }), /connection.*retry/i);
  assert.match(directPlaybackError({ code: 4 }), /unavailable or unsupported.*retry/i);
});
