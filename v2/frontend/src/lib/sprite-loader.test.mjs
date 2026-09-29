import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpriteLoader } from './sprite-loader.js';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function fixture(fetcher) {
  const jobs = new Map(); let id = 0, received = 0, preloaded = 0;
  const loader = createSpriteLoader({ id: 'episode', fetcher, onData() { received++; }, preload() { preloaded++; },
    timers: { setTimeout(fn) { jobs.set(++id, fn); return id; }, clearTimeout(id) { jobs.delete(id); } } });
  return { loader, jobs, get received() { return received; }, get preloaded() { return preloaded; } };
}
test('closing during the request cannot preload sprites or restart polling', async () => {
  const response = deferred(), f = fixture(() => response.promise); const pending = f.loader.load();
  f.loader.stop(); response.resolve({ ok: true, json: async () => ({ status: 'generating', totalSheets: 3 }) });
  await pending; assert.equal(f.received, 0); assert.equal(f.preloaded, 0); assert.equal(f.jobs.size, 0);
});
test('closing while reading response metadata also invalidates the result', async () => {
  const metadata = deferred(); const f = fixture(async () => ({ ok: true, json: () => metadata.promise }));
  const pending = f.loader.load(); await Promise.resolve(); f.loader.stop();
  metadata.resolve({ status: 'generating', totalSheets: 3 }); await pending;
  assert.equal(f.received, 0); assert.equal(f.preloaded, 0); assert.equal(f.jobs.size, 0);
});
test('generation metadata renders immediately and queued polling cannot run after stop', async () => {
  let requests = 0; const f = fixture(async () => { requests++; return { ok: true, json: async () => ({ status: 'generating', totalSheets: 3 }) }; });
  await f.loader.load(); assert.equal(f.received, 1); assert.equal(f.preloaded, 1); assert.equal(f.jobs.size, 1);
  const queued = [...f.jobs.values()][0]; f.loader.stop(); await queued(); assert.equal(requests, 1); assert.equal(f.jobs.size, 0);
});
test('finished sheets are preloaded without further polling', async () => {
  const f = fixture(async () => ({ ok: true, json: async () => ({ status: 'ready', totalSheets: 3 }) }));
  await f.loader.load(); assert.equal(f.received, 1); assert.equal(f.preloaded, 1); assert.equal(f.jobs.size, 0);
});
