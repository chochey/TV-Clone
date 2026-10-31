const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('node:stream');
const register = require('./riftwarden');

// A response that is a real writable stream, so the launcher can be piped into it like Express's.
function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  Object.assign(res, {
    statusCode: 200, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; this.end(); return this; },
    send(v) { this.body = v; this.end(); return this; },
    set(k, v) { this.headers[k.toLowerCase()] = String(v); return this; },
    attachment(name) { this.headers['content-disposition'] = `attachment; filename="${name}"`; return this; },
  });
  res.data = () => Buffer.concat(chunks);
  return res;
}

function fixture(t, { latest, launcher = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riftwarden-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (latest !== null) fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(latest || {
    version: '0.9.3', date: '2026-10-31', notes: 'Auto-start waves.', url: 'RiftWarden-0.9.3.zip', size: 55352752,
    launcher: { version: 4, url: 'RiftWardenLauncher.exe', sha256: 'abc123', size: 1234 },
  }));
  if (launcher) fs.writeFileSync(path.join(dir, 'RiftWardenLauncher.exe'), Buffer.alloc(1234, 7));
  const routes = new Map(); const saved = [];
  const app = { get: (route, ...h) => routes.set(`get ${route}`, h) };
  register(app, { requirePermission: name => Object.assign(() => {}, { permission: name }), dir, onSaved: s => saved.push(s) });
  async function call(key, { method = 'GET' } = {}) {
    const res = fakeRes();
    const done = new Promise(resolve => { res.on('finish', resolve); res.on('close', resolve); });
    routes.get(key).at(-1)({ headers: {}, method, ip: '10.0.0.9' }, res);
    await Promise.race([done, new Promise(r => setTimeout(r, 2000))]);
    await new Promise(r => setImmediate(r));
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

test('the launcher downloads whole under its own name, is logged once, and a path in latest.json is ignored', async t => {
  const f = fixture(t);
  const res = await f.call('get /api/riftwarden/launcher');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-disposition'], 'attachment; filename="RiftWardenLauncher.exe"');
  assert.equal(res.headers['content-length'], '1234');
  assert.equal(res.data().length, 1234);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].completed, true);
  assert.equal(f.saved[0].title, 'Rift Warden launcher');
  assert.equal(f.saved[0].req.ip, '10.0.0.9');
  const sneaky = fixture(t, { latest: { version: '1', launcher: { url: '../../etc/passwd' } } });
  const r2 = await sneaky.call('get /api/riftwarden/launcher');
  assert.equal(r2.headers['content-disposition'], 'attachment; filename="RiftWardenLauncher.exe"');
  assert.equal(r2.data().length, 1234);
});

test('a HEAD request gets the size and name but no file, and is not logged', async t => {
  const f = fixture(t);
  const res = await f.call('get /api/riftwarden/launcher', { method: 'HEAD' });
  assert.equal(res.headers['content-length'], '1234');
  assert.equal(res.data().length, 0);
  assert.deepEqual(f.saved, []);
});

test('a launcher that is a link to a file outside the folder is never served or measured', async t => {
  const f = fixture(t, { launcher: false });
  const outside = path.join(os.tmpdir(), `riftwarden-secret-${process.pid}.txt`);
  fs.writeFileSync(outside, 'TOP SECRET');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(f.dir, 'RiftWardenLauncher.exe'));
  assert.deepEqual((await f.call('get /api/riftwarden')).body, { ok: false, error: 'not-available' });
  const res = await f.call('get /api/riftwarden/launcher');
  assert.equal(res.statusCode, 404);
  assert.ok(!res.data().includes('TOP SECRET'));
});

test('a link to another file inside the folder still works, and the real file is what gets sent', async t => {
  const f = fixture(t, { launcher: false });
  fs.writeFileSync(path.join(f.dir, 'RiftWardenLauncher-v4.exe'), Buffer.alloc(77, 1));
  fs.symlinkSync('RiftWardenLauncher-v4.exe', path.join(f.dir, 'RiftWardenLauncher.exe'));
  assert.equal((await f.call('get /api/riftwarden')).body.launcher.bytes, 77);
  const res = await f.call('get /api/riftwarden/launcher');
  assert.equal(res.data().length, 77);
  assert.equal(res.headers['content-disposition'], 'attachment; filename="RiftWardenLauncher.exe"');
});
