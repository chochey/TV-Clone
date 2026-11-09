import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadOnceForMissingPage } from './lazy-page.js';

function memory() { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }

test('a page that will not load reloads the app once a minute at most', () => {
  const storage = memory();
  assert.equal(reloadOnceForMissingPage(storage, 1000), true, 'a tab older than the deploy picks up the new build');
  assert.equal(reloadOnceForMissingPage(storage, 30000), false, 'a page still missing after that shows its error');
  assert.equal(reloadOnceForMissingPage(storage, 61001), true);
});

test('without somewhere to remember the reload it never reloads, so it cannot loop', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(reloadOnceForMissingPage(broken, 1000), false);
  assert.equal(reloadOnceForMissingPage(undefined, 1000), false);
});
