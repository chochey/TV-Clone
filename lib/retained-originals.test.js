const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createInventory = require('./retained-originals');
const { newPathFor } = require('./conversion-worker');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('inventory yields, shares concurrent scans, caches, and invalidates after mutations', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gate = deferred(); let reads = 0;
  const inventory = createInventory({ newPathFor, io: { ...fs.promises, async readdir(...args) { reads++; await gate.promise; return fs.promises.readdir(...args); } } });
  const a = inventory.list([root], 14), b = inventory.list([root], 14);
  await new Promise(r => setImmediate(r)); assert.equal(reads, 1);
  gate.resolve(); assert.deepEqual(await a, []); assert.deepEqual(await b, []);
  await inventory.list([root], 14); assert.equal(reads, 1);
  const dir = path.join(root, '.converted-originals'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'film.mkv'), 'source'); fs.writeFileSync(path.join(root, 'film.mp4'), 'replacement');
  inventory.invalidate(); const items = await inventory.list([root], 14);
  assert.equal(items.length, 1); assert.equal(items[0].restorable, true);
  items[0].restorable = false; assert.equal((await inventory.list([root], 14))[0].restorable, true);
});

test('invalidating an in-flight scan prevents its stale result from filling the cache', async () => {
  const gate = deferred(); let reads = 0;
  const inventory = createInventory({ newPathFor, io: { async readdir() { reads++; if (reads === 1) await gate.promise; return []; } } });
  const old = inventory.list(['/audit'], 14); inventory.invalidate();
  await inventory.list(['/audit'], 14); gate.resolve(); await old;
  await inventory.list(['/audit'], 14); assert.equal(reads, 2);
});

test('failed scans do not cache an incomplete zero budget', async () => {
  let fail = true, calls = 0;
  const inventory = createInventory({ newPathFor, io: { async readdir() { calls++; if (fail) throw Object.assign(Error('offline'), { code: 'EIO' }); return []; } } });
  await assert.rejects(inventory.list(['/audit'], 14), /offline/);
  fail = false; await inventory.list(['/audit'], 14); assert.equal(calls, 2);
});

test('retention age is recomputed while inventory entries remain cached', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-age-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.converted-originals'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'film.mkv'), 'source');
  fs.writeFileSync(path.join(dir, 'film.mkv.conversion.json'), JSON.stringify({ retainedAt: 0 }));
  let time = 1000; const inventory = createInventory({ newPathFor, now: () => time, ttlMs: Infinity });
  assert.equal((await inventory.list([root], 1))[0].expired, false);
  time = 2 * 86400000; assert.equal((await inventory.list([root], 1))[0].expired, true);
});
