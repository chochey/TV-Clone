const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadJSON, saveJSONSync } = require('../json-store');
const registerOrganizerRoutes = require('./organizer');

const stamp = (minutesAgo) => {
  const d = new Date(Date.now() - minutesAgo * 60000), p = n => String(n).padStart(2, '0');
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
};

function fixture(t, { logLines = [], status = null, share = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'media-organizer.log'), statusFile = path.join(dir, 'organizer-status.json');
  fs.writeFileSync(logPath, logLines.join('\n') + '\n');
  if (status) fs.writeFileSync(statusFile, JSON.stringify({ version: 1, pid: 1, scans: 1, ...status }));
  const sourceDir = path.join(dir, 'Share');
  if (share) fs.mkdirSync(sourceDir);
  const routes = new Map(), pass = () => {}, logs = [];
  const app = Object.fromEntries(['get', 'post', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const api = registerOrganizerRoutes(app, { requirePermission: () => pass, requireAdminSession: pass, loadJSON, saveJSONSync,
    logPath, statusFile, aliasFile: path.join(dir, 'organizer_aliases.json'), sourceDir, retryDir: path.join(dir, 'retries'),
    libraryPaths: () => [], log: line => logs.push(line) });
  async function call(method, route, req = {}) {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } };
    await routes.get(`${method} ${route}`).at(-1)({ query: {}, params: {}, body: {}, ...req }, res);
    return res;
  }
  return { call, api, dir, logs };
}

test('the log view hides heartbeats and machine events, counts the last day, and takes liveness from the status file', async t => {
  const f = fixture(t, { status: { updatedAt: Date.now() - 5000 }, logLines: [
    `${stamp(30)} Still watching...`, `${stamp(20)} Moved -> /mnt/media/Movies/Film (2001)/Film (2001).mkv`,
    `${stamp(20)} EVENT: {"type": "moved"}`, `${stamp(10)} SKIP: no confident match for Thing`, `${stamp(5)} ERROR: something broke`] });
  const res = await f.call('get', '/api/organizer/logs');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.lines.some(l => /Still watching|EVENT:/.test(l)), false);
  assert.deepEqual([res.body.meta.moves24h, res.body.meta.skips24h, res.body.meta.errors24h], [1, 1, 1]);
  assert.ok(Date.now() - res.body.meta.lastHeartbeat < 60000, 'the status file is fresher than the hourly heartbeat line');
  const errors = await f.call('get', '/api/organizer/logs', { query: { filter: 'errors' } });
  assert.equal(errors.body.lines.length, 2);
  assert.equal(f.api.readOrganizerLogLines().length, 5, 'the raw tail is shared with the download status code');
});

test('aliases can be added, listed and removed, and incomplete ones are refused', async t => {
  const f = fixture(t);
  assert.equal((await f.call('post', '/api/organizer/aliases', { body: { from: 'Shogun' } })).code, 400);
  const added = await f.call('post', '/api/organizer/aliases', { body: { from: 'Shogun 2024', to: 'Shōgun', type: 'series' } });
  assert.equal(added.body.ok, true);
  assert.equal((await f.call('get', '/api/organizer/aliases')).body.aliases.length, 1);
  assert.equal((await f.call('delete', '/api/organizer/aliases/:id', { params: { id: 'nope' } })).code, 404);
  assert.equal((await f.call('delete', '/api/organizer/aliases/:id', { params: { id: added.body.alias.id } })).body.aliases.length, 0);
});

test('clearing leftovers needs a list, and never clears a release that does not qualify', async t => {
  const f = fixture(t);
  assert.equal((await f.call('post', '/api/organizer/clear-leftovers', { body: { names: [] } })).code, 400);
  fs.mkdirSync(path.join(f.dir, 'Share', 'Some.Release.2001'));
  const res = await f.call('post', '/api/organizer/clear-leftovers', { body: { names: ['Some.Release.2001'] } });
  assert.deepEqual(res.body.cleared, []);
  assert.match(res.body.skipped[0].reason, /no longer qualifies/);
  assert.ok(fs.existsSync(path.join(f.dir, 'Share', 'Some.Release.2001')));
});

test('an unreadable download folder makes the review queue say so', async t => {
  const f = fixture(t, { share: false });
  const res = await f.call('get', '/api/organizer/fix-queue');
  assert.equal(res.code, 503); assert.match(res.body.error, /download folder/);
});
