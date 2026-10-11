import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadedAppVersion, createAppUpdateMonitor, canRefreshApp } from './app-updates.js';

test('update baseline is the actually loaded module, including a deployment before the first poll', async () => {
  const version = loadedAppVersion({ baseURI: 'https://tv.test/', querySelectorAll: () => [{ src: '/assets/index-old.js' }, { href: '/assets/index-old.css' }] });
  assert.equal(version, 'index-old.css|index-old.js');
  const updates = [], monitor = createAppUpdateMonitor({ initialVersion: version, load: async () => ({ version: 'index-new.js' }), onUpdate: value => updates.push(value) });
  await monitor.check(); assert.deepEqual(updates, [true]);
  assert.equal(canRefreshApp(true, true), false); assert.equal(canRefreshApp(true, false), true);
});

test('a stylesheet-only update differs from the loaded build and external fonts do not enter its version', async () => {
  const version = loadedAppVersion({ baseURI: 'https://tv.test/', querySelectorAll: () => [
    { href: 'https://fonts.googleapis.com/css2?family=Inter' }, { href: '/assets/index-before.css' }, { src: '/assets/index-same.js' },
  ] });
  const updates = [], monitor = createAppUpdateMonitor({ initialVersion: version,
    load: async () => ({ version: 'index-after.css|index-same.js' }), onUpdate: value => updates.push(value) });
  await monitor.check(); assert.deepEqual(updates, [true]);
});

test('polling shares pending work, ignores invalid replies, and never delivers after teardown', async () => {
  let release, calls = 0; const updates = [];
  const monitor = createAppUpdateMonitor({ initialVersion: 'old', load: () => { calls++; return new Promise(resolve => { release = resolve; }); }, onUpdate: value => updates.push(value) });
  const first = monitor.check(); await monitor.check(); assert.equal(calls, 1);
  release({}); await first; assert.deepEqual(updates, []);
  const second = monitor.check(); monitor.stop(); release({ version: 'new' }); await second;
  assert.deepEqual(updates, []);
});
