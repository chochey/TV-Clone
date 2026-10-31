const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');
const register = require('./riftwarden');

function fixture(t, { latest, launcher = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riftwarden-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (latest !== null) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(latest || {
    version: '0.9.3', date: '2026-10-31', notes: 'Auto-start waves.', url: 'RiftWarden-0.9.3.zip', size: 55352752,
    launcher: { version: 4, url: 'RiftWardenLauncher.exe', sha256: 'abc123', size: 1234 },
  }));
  if (launcher) fs.writeFileSync(path.join(dir, 'RiftWardenLauncher.exe'), Buffer.alloc(1234));
  const routes = new Map(); const saved = [];
  const app = { get: (route, ...h) => routes.set(`get ${route}`, h) };
  register(app, { requirePermission: name => Object.assign(() => {}, { permission: name }), dir, onSaved: s => saved.push(s) });
  async function call(key) {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; },
      send(v) { this.body = v; return this; }, download(file, name, cb) { this.downloaded = { file, name }; this.done = cb; return this; } });
    await routes.get(key).at(-1)({ headers: {}, ip: '10.0.0.9' }, res);
    return res;
  }
  return { dir, routes, call, saved };
}

test('both Rift Warden routes need the Rift Warden permission', t => {
  const f = fixture(t);
  assert.equal(f.routes.get('get /api/riftwarden')[0].permission, 'canRiftWarden');
  assert.equal(f.routes.get('get /api/riftwarden/launcher')[0].permission, 'canRiftWarden');
});

test('the page info comes from latest.json and the launcher file', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.call('get /api/riftwarden')).body, {
    ok: true, version: '0.9.3', date: '2026-10-31', notes: 'Auto-start waves.',
    launcher: { file: 'RiftWardenLauncher.exe', bytes: 1234, version: 4, sha256: 'abc123' },
  });
});

test('without a launcher or release file the page says it is not available', async t => {
  assert.deepEqual((await fixture(t, { launcher: false }).call('get /api/riftwarden')).body, { ok: false, error: 'not-available' });
  const noJson = await fixture(t, { latest: null }).call('get /api/riftwarden');
  assert.equal(noJson.body.ok, true, 'the launcher alone is enough');
  assert.equal(noJson.body.version, null);
  const res = await fixture(t, { launcher: false }).call('get /api/riftwarden/launcher');
  assert.equal(res.statusCode, 404);
});

test('the launcher downloads under its own name, is logged once, and a path in latest.json is ignored', async t => {
  const f = fixture(t);
  const res = await f.call('get /api/riftwarden/launcher');
  assert.deepEqual(res.downloaded, { file: path.join(f.dir, 'RiftWardenLauncher.exe'), name: 'RiftWardenLauncher.exe' });
  res.emit('finish'); res.emit('close');
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].completed, true);
  assert.equal(f.saved[0].title, 'Rift Warden launcher');
  assert.equal(f.saved[0].req.ip, '10.0.0.9');
  const sneaky = fixture(t, { latest: { version: '1', launcher: { url: '../../etc/passwd' } } });
  const r2 = await sneaky.call('get /api/riftwarden/launcher');
  assert.equal(r2.downloaded.file, path.join(sneaky.dir, 'RiftWardenLauncher.exe'));
});
