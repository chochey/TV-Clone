const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const register = require('./system-control');

function fixture(t, { script, python = process.execPath, serviceResults = {}, dockerResult = { ok: true } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-control-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'movie_renamer.js');
  if (script !== null) fs.writeFileSync(scriptPath, script || "console.log(process.argv.slice(2).join(' ')); console.log(process.env.ORGANIZER_PREVIEW, process.env.ORGANIZER_ALIAS_FILE);");
  const routes = new Map(); const calls = [];
  const app = Object.fromEntries(['get', 'post'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  register(app, {
    requireAdminSession() {}, requirePermission: name => Object.assign(() => {}, { permission: name }),
    organizerScript: scriptPath, organizerAliasFile: '/aliases.json', python,
    sys: {
      ALLOWED_CONTAINERS: ['qbittorrent', 'gluetun'],
      organizerServiceCmd: async action => { calls.push(['service', action]); return serviceResults[action] || { ok: true, code: 0 }; },
      dockerCmd: async (action, container) => { calls.push(['docker', action, container]); return dockerResult; },
      dockerInspect: async names => ({ names }),
      dockerComposeRepair: async () => ({ ok: true, repaired: 1 }),
    },
  });
  async function call(key, params = {}) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
    const handlers = routes.get(key);
    await new Promise((resolve) => {
      const done = res.json.bind(res);
      res.json = v => { done(v); resolve(); return res; };
      handlers.at(-1)({ params, body: {} }, res);
    });
    return res;
  }
  return { call, calls, routes };
}

test('organizer preview runs the script as a dry run and returns its output', async t => {
  const f = fixture(t);
  const res = await f.call('post /api/organizer/preview');
  assert.deepEqual(res.body, { ok: true, code: 0, lines: ['--dry-run', '1 /aliases.json'], truncated: false });
});

test('organizer preview reports a missing script, a failed exit, and a spawn failure once', async t => {
  assert.equal((await fixture(t, { script: null }).call('post /api/organizer/preview')).statusCode, 404);
  const failed = await fixture(t, { script: "console.error('boom'); process.exit(3)" }).call('post /api/organizer/preview');
  assert.deepEqual(failed.body, { ok: false, code: 3, lines: ['boom'], truncated: false });
  const missingPython = await fixture(t, { python: '/nonexistent/python3' }).call('post /api/organizer/preview');
  assert.equal(missingPython.statusCode, 500);
  assert.match(missingPython.body.error, /ENOENT/);
});

test('organizer service routes report the systemctl result', async t => {
  const f = fixture(t, { serviceResults: { status: { ok: false, code: 3 }, stop: { ok: false, stderr: 'denied' } } });
  assert.deepEqual((await f.call('get /api/organizer/status')).body, { ok: true, active: false, code: 3 });
  assert.deepEqual((await f.call('post /api/organizer/stop')).body, { ok: false, error: 'denied' });
  assert.deepEqual((await f.call('post /api/organizer/start')).body, { ok: true, error: undefined });
  assert.deepEqual((await f.call('post /api/organizer/restart')).body, { ok: true, error: undefined });
  assert.deepEqual(f.calls, [['service', 'status'], ['service', 'stop'], ['service', 'start'], ['service', 'restart']]);
  assert.equal(f.routes.get('get /api/organizer/status')[0].permission, 'canOrganizer');
  assert.equal(f.routes.get('post /api/organizer/restart')[0].permission, 'canRestart');
});

test('docker routes pass the allowed names and the requested action through', async t => {
  const f = fixture(t, { dockerResult: { ok: false, stderr: 'not allowed' } });
  assert.deepEqual((await f.call('get /api/docker/status')).body, { names: ['qbittorrent', 'gluetun'] });
  assert.deepEqual((await f.call('post /api/docker/:action/:container', { action: 'restart', container: 'gluetun' })).body, { ok: false, error: 'not allowed' });
  assert.deepEqual(f.calls, [['docker', 'restart', 'gluetun']]);
  assert.deepEqual((await f.call('post /api/docker/repair')).body, { ok: true, repaired: 1 });
});
