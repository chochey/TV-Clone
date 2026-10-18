import test from 'node:test';
import assert from 'node:assert/strict';
import { createVolumeBoost, savedVolumePercent } from './volume-boost.js';

function fakeContext() {
  const made = [];
  class Ctx {
    constructor() { this.state = 'suspended'; this.closed = false; made.push(this); }
    createMediaElementSource(el) { return { connect: node => { this.chain = [el, node]; } }; }
    createGain() { const gain = { gain: { value: 1 }, connect: dest => { gain.dest = dest; } }; this.gainNode = gain; return gain; }
    get destination() { return 'speakers'; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.closed = true; }
  }
  return { Ctx, made };
}

test('up to 100% only sets the element; past it audio is routed through one gain stage', () => {
  const video = { volume: 1, muted: false }, storage = new Map();
  const { Ctx, made } = fakeContext();
  const boost = createVolumeBoost({ getVideo: () => video, AudioContext: Ctx, save: v => storage.set('pct', v) });
  assert.deepEqual(boost.set(60), { volume: 60, muted: false });
  assert.equal(video.volume, 0.6);
  assert.equal(made.length, 0, 'no audio graph until the boost is needed');
  assert.deepEqual(boost.set(140), { volume: 140, muted: false });
  assert.equal(video.volume, 1);
  assert.equal(made.length, 1);
  assert.equal(made[0].gainNode.gain.value, 1.4);
  assert.equal(made[0].state, 'running');
  boost.set(149.6); boost.set(200);
  assert.equal(made.length, 1, 'the graph is built once');
  assert.deepEqual(boost.set(-5), { volume: 0, muted: true });
  assert.equal(video.muted, true);
  assert.equal(made[0].gainNode.gain.value, 0);
  assert.equal(storage.get('pct'), 0);
});

test('muting sets the element and silences the boost without losing the level', () => {
  const video = { volume: 1, muted: false };
  const { Ctx, made } = fakeContext();
  const boost = createVolumeBoost({ getVideo: () => video, AudioContext: Ctx, save() {} });
  boost.set(120);
  assert.equal(boost.setMuted(true, 120), true);
  assert.equal(video.muted, true);
  assert.equal(made[0].gainNode.gain.value, 0);
  assert.equal(boost.setMuted(false, 120), false);
  assert.equal(made[0].gainNode.gain.value, 1.2);
  boost.close();
  assert.equal(made[0].closed, true);
});

test('a browser without Web Audio still gets native volume', () => {
  const video = { volume: 1, muted: false };
  const boost = createVolumeBoost({ getVideo: () => video, AudioContext: undefined, save() {} });
  assert.deepEqual(boost.set(130), { volume: 130, muted: false });
  assert.equal(video.volume, 1);
});

test('the saved level prefers the percent key and migrates the old 0-1 key', () => {
  const store = values => ({ getItem: k => (k in values ? values[k] : null) });
  assert.equal(savedVolumePercent(store({ playerVolumePct: '120' })), 120);
  assert.equal(savedVolumePercent(store({ playerVolume: '0.4' })), 40);
  assert.equal(savedVolumePercent(store({})), 100);
  assert.equal(savedVolumePercent(store({ playerVolumePct: '400' })), 150);
});
