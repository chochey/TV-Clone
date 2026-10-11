import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSleepTimer, rememberedAudioSpeed, audioBookmarks } from './listening-tools.js';

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
