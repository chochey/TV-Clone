const test = require('node:test');
const assert = require('node:assert/strict');
const createStore = require('./library-folder-store');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('failed durable folder writes leave config and refresh state unchanged', async () => {
  const config = { folders: [{ path: '/original' }], profiles: [{ id: 'existing' }] };
  let refreshed = 0;
  const store = createStore({ getConfig: () => config, persist: async () => { throw Error('disk unavailable'); }, onChange: () => refreshed++ });
  await assert.rejects(store.update(() => [{ path: '/new' }]), /disk unavailable/);
  assert.equal(config.folders[0].path, '/original'); assert.equal(refreshed, 0);
});

test('folder mutations wait for durable saves and preserve concurrent non-folder config edits', async () => {
  const config = { folders: [], profiles: [{ id: 'existing' }] };
  let release; const gate = new Promise(resolve => { release = resolve; });
  const snapshots = [];
  const store = createStore({ getConfig: () => config, persist: async value => {
    snapshots.push(JSON.parse(JSON.stringify(value))); if (snapshots.length === 1) await gate;
  } });
  const update = store.update(() => [{ path: '/new' }]); await settle();
  assert.deepEqual(config.folders, [], 'uncommitted roots must not become visible');
  config.profiles.push({ id: 'new-profile' }); release(); await update;
  assert.equal(config.folders[0].path, '/new'); assert.equal(config.profiles.length, 2);
  assert.equal(snapshots.at(-1).profiles.length, 2, 'latest unrelated config fields are durably replayed');
});

test('concurrent folder requests build from the last committed set instead of losing a location', async () => {
  const config = { folders: [] }; let release; const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const store = createStore({ getConfig: () => config, persist: async () => { if (++writes === 1) await gate; } });
  const first = store.update(current => [...current, { path: '/one' }]);
  const second = store.update(current => [...current, { path: '/two' }]);
  await settle(); assert.equal(writes, 1); release(); await Promise.all([first, second]);
  assert.deepEqual(config.folders.map(folder => folder.path), ['/one', '/two']);
});
