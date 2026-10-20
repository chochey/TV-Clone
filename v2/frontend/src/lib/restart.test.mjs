// Did the app really restart? "Health answers" is not enough: a request that was refused or
// ignored leaves the old process answering at once. The proof is a health reading whose uptime
// is lower than before the request (the new process starts near zero).
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForRestart } from './restart.js';

const healthSequence = (readings) => {
  let i = 0;
  return async () => { const r = readings[Math.min(i++, readings.length - 1)]; if (r === 'down') throw new Error('down'); return r; };
};

test('restarted once the uptime falls below what it was before the request', async () => {
  const slept = [];
  const result = await waitForRestart({ uptimeBefore: 5000, health: healthSequence([{ uptime: 5001 }, 'down', 'down', { uptime: 2 }]), sleep: ms => { slept.push(ms); }, timeoutMs: 90000 });
  assert.equal(result, 'restarted');
  assert.equal(slept.length, 4, 'polls were spaced out');
});

test('not restarted when the uptime only keeps growing until the deadline', async () => {
  let now = 0;
  const result = await waitForRestart({ uptimeBefore: 5000, health: healthSequence([{ uptime: 5002 }, { uptime: 5004 }]), sleep: () => { now += 1500; }, now: () => now, timeoutMs: 9000 });
  assert.equal(result, 'not-restarted');
});

test('a health reply without an uptime counts once the app has been down and is back', async () => {
  const result = await waitForRestart({ uptimeBefore: null, health: healthSequence([{ ready: true }, 'down', { ready: true }]), sleep: () => {}, timeoutMs: 90000 });
  assert.equal(result, 'restarted');
});

test('without an uptime and without ever being down, nothing proves a restart', async () => {
  let now = 0;
  const result = await waitForRestart({ uptimeBefore: null, health: healthSequence([{ ready: true }]), sleep: () => { now += 1500; }, now: () => now, timeoutMs: 6000 });
  assert.equal(result, 'not-restarted');
});
