import test from 'node:test';
import assert from 'node:assert/strict';
import { audioMimeType, audioPlaybackError, audioResumePosition, audioProgressPayload, audioTime, startAudioPlayback } from './audio-playback.js';

function fixture({ supported = true, start = 12, item = { id: 'podcast/id', filename: 'Episode.mp3', streamMode: 'hls' } } = {}) {
  const events = new Map(), jobs = new Map();
  let playCalls = 0, id = 0, error = '', ready = 0, current = true;
  const audio = {
    paused: true, readyState: 0, currentTime: 0, duration: 60,
    canPlayType(type) { this.checkedType = type; return supported ? 'probably' : ''; },
    pause() {}, play() { playCalls++; return new Promise(() => {}); },
    addEventListener(key, fn) { events.set(key, fn); },
    removeEventListener(key, fn) { if (events.get(key) === fn) events.delete(key); },
  };
  const timers = { setTimeout(fn) { jobs.set(++id, fn); return id; }, clearTimeout(value) { jobs.delete(value); } };
  const cancel = startAudioPlayback(audio, item, start, { timers, isCurrent: () => current,
    onMetadata() { ready++; }, onBlocked() {}, onTimeout() {}, onError(message) { error = message; } });
  return { audio, events, jobs, cancel, stale() { current = false; }, get playCalls() { return playCalls; }, get error() { return error; }, get ready() { return ready; } };
}

test('native audio MIME hints cover common formats and preserve direct playback despite a stale video mode', () => {
  const types = { mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac' };
  for (const [extension, mime] of Object.entries(types)) {
    const f = fixture({ item: { id: 'audio', filename: `Track.${extension.toUpperCase()}` } });
    assert.equal(audioMimeType({ filename: `track.${extension}` }), mime);
    assert.equal(f.audio.checkedType, mime);
    assert.equal(f.audio.src, '/stream/audio');
    assert.equal(f.playCalls, 1);
    f.cancel();
  }
  const f = fixture(); assert.equal(f.audio.src, '/stream/podcast%2Fid'); f.cancel();
});

test('unsupported native codecs explain the failure without creating a video fallback', () => {
  const f = fixture({ supported: false });
  assert.match(f.error, /does not support.*audio format.*another browser/i);
  assert.equal(f.playCalls, 0);
  assert.equal(f.audio.src, undefined);
  assert.equal(f.jobs.size, 0);
});

test('audio resume is applied at metadata and invalid past-end bookmarks restart at zero', () => {
  const f = fixture(); f.events.get('loadedmetadata')();
  assert.equal(f.audio.currentTime, 12); assert.equal(f.ready, 1); f.cancel();
  const stale = fixture({ start: 100 }); stale.events.get('loadedmetadata')();
  assert.equal(stale.audio.currentTime, 0); stale.cancel();
  assert.equal(audioResumePosition({ currentTime: 33, percent: 25 }), 33);
  assert.equal(audioResumePosition({ currentTime: 33, percent: 92 }), 0);
  assert.equal(audioResumePosition({ currentTime: NaN }), 0);
});

test('audio teardown or replacement cannot seek or retain startup timers', () => {
  const f = fixture(); const metadata = f.events.get('loadedmetadata'); f.cancel(); metadata();
  assert.equal(f.audio.currentTime, 0); assert.equal(f.ready, 0); assert.equal(f.events.size, 0); assert.equal(f.jobs.size, 0);
  const old = fixture(); old.stale(); old.events.get('loadedmetadata')();
  assert.equal(old.ready, 0); old.cancel();
});

test('audio progress uses the same finite resume contract and marks natural completion', () => {
  const item = { id: 'track' };
  assert.deepEqual(audioProgressPayload(item, 12, 100, 'listener'), { id: 'track', currentTime: 12, duration: 100, profile: 'listener' });
  assert.equal(audioProgressPayload(item, 12, 100, 'listener', true).currentTime, 100);
  assert.equal(audioProgressPayload(item, 120, 100, 'listener').currentTime, 100);
  for (const [time, duration] of [[NaN, 100], [-1, 100], [1, Infinity], [1, 0]]) assert.equal(audioProgressPayload(item, time, duration, 'listener'), null);
  assert.match(audioPlaybackError({ code: 2 }), /server connection.*retry/i);
  assert.match(audioPlaybackError({ code: 4 }), /unsupported.*another browser/i);
  assert.equal(audioTime(3671), '1:01:11');
});
