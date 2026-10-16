import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSleepTimer, rememberedAudioSpeed, audioBookmarks, rememberedAudioVolume, rememberAudioVolume, rememberedAudioMuted, rememberAudioMuted } from './listening-tools.js';

const fakeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
};

test('volume is remembered across reloads on this device', () => {
  const storage = fakeStorage();
  assert.equal(rememberAudioVolume(0.25, storage), 0.25);
  assert.equal(rememberedAudioVolume(storage), 0.25);
  // Silence is a deliberate choice and must survive, unlike an absent setting.
  rememberAudioVolume(0, storage);
  assert.equal(rememberedAudioVolume(storage), 0);
});

test('an unset, unusable or unreadable volume falls back to full, never silence', () => {
  // getItem returns null when unset and Number(null) is 0, which would have
  // started every new listener muted.
  assert.equal(rememberedAudioVolume(fakeStorage()), 1);
  for (const stored of ['', 'loud', 'NaN', 'null']) {
    assert.equal(rememberedAudioVolume(fakeStorage({ 'tvclone.audio.volume': stored })), 1, stored);
  }
  // Private windows and blocked site data make storage throw on access.
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(rememberedAudioVolume(hostile), 1);
  assert.equal(rememberAudioVolume(0.4, hostile), 0.4, 'playback still applies the new volume');
});

test('stored volumes are clamped into range', () => {
  assert.equal(rememberedAudioVolume(fakeStorage({ 'tvclone.audio.volume': '7' })), 1);
  assert.equal(rememberedAudioVolume(fakeStorage({ 'tvclone.audio.volume': '-3' })), 0);
  assert.equal(rememberAudioVolume(1.8, fakeStorage()), 1);
  assert.equal(rememberAudioVolume('0.5', fakeStorage()), 0.5);
});

test('sleep timer expires once, replacement cancels the old timer, and teardown clears it', () => {
  const jobs = new Map(), expired = []; let id = 0, time = 100;
  const timer = createSleepTimer({ now: () => time, setTimer: (fn, delay) => { jobs.set(++id, { fn, delay }); return id; },
    clearTimer: id => jobs.delete(id), onExpire: plan => expired.push(plan) });
  const first = timer.set('15'); assert.equal(first.deadline, 900100); assert.equal(jobs.get(1).delay, 900000);
  timer.set('30'); assert.equal(jobs.has(1), false);
  time = 1800100; timer.position(8); assert.equal(expired.length, 1); assert.equal(jobs.size, 0);
  timer.position(8); assert.equal(expired.length, 1);
  timer.set('60'); timer.destroy(); assert.equal(jobs.size, 0);
});

test('chapter sleep follows the selected chapter boundary and off cancels it', () => {
  const expired = [], timer = createSleepTimer({ onExpire: plan => expired.push(plan) });
  timer.set('chapter', 20); timer.position(19.9); assert.equal(expired.length, 0);
  timer.position(20.2); assert.deepEqual(expired, [{ mode: 'chapter', end: 20 }]);
  timer.set('chapter', 40); timer.set('off'); timer.position(45); assert.equal(expired.length, 1);
  assert.equal(timer.set('chapter', NaN), null); timer.destroy();
});

test('remembered speeds and bookmarks reject malformed server values', () => {
  assert.equal(rememberedAudioSpeed('1.5'), 1.5);
  for (const value of [Infinity, -1, null, {}, 'fast']) assert.equal(rememberedAudioSpeed(value), 1);
  assert.deepEqual(audioBookmarks({ bookmarks: [null, { id: 'bad', time: -1 }, { id: 'late', time: 50 }, { id: 'early', time: 4, label: 'Opening' }] })
    .map(bookmark => [bookmark.id, bookmark.label]), [['early', 'Opening'], ['late', '']]);
});


test('mute is remembered, and defaults to sound on', () => {
  const storage = fakeStorage();
  assert.equal(rememberedAudioMuted(storage), false, 'an unset preference must not start silent');
  assert.equal(rememberAudioMuted(true, storage), true);
  assert.equal(rememberedAudioMuted(storage), true);
  assert.equal(rememberAudioMuted(false, storage), false);
  assert.equal(rememberedAudioMuted(storage), false);
  // Anything unrecognised in storage means "not muted" rather than silence.
  assert.equal(rememberedAudioMuted(fakeStorage({ 'tvclone.audio.muted': 'yes' })), false);
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(rememberedAudioMuted(hostile), false);
  assert.equal(rememberAudioMuted(true, hostile), true, 'playback still mutes even if it cannot be saved');
});
