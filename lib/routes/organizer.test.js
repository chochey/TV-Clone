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

test('the log view also returns the activity feed, newest first, filtered by the same words', async t => {
  const f = fixture(t, { logLines: [
    `${stamp(60)} [MOVIE] Found: Signal One (2026) [1080p] [WEBRip]`,
    `${stamp(59)} Import source: /mnt/media/Share/Signal One (2026) [1080p] [WEBRip]/s.mkv -> /mnt/media/Movies/Signal One (2026)/Signal One (2026).mkv`,
    `${stamp(59)} Moved -> /mnt/media/Movies/Signal One (2026)/Signal One (2026).mkv`,
    `${stamp(59)} Retained source folder with remaining files: Signal One (2026) [1080p] [WEBRip]`,
    `${stamp(58)} Scan complete. Movies: 1/1, TV: 0/0`,
    `${stamp(30)} SKIP: No confident OMDb match for: Mystery Film (2020)`,
    `${stamp(10)} Still watching...`] });
  const res = await f.call('get', '/api/organizer/logs');
  assert.deepEqual(res.body.entries.map(entry => entry.kind), ['skip', 'import']);
  assert.equal(res.body.entries[1].title, 'Signal One (2026)');
  assert.equal(res.body.entriesTotal, 2);
  assert.equal(res.body.meta.lastImport.title, 'Signal One (2026)');
  const problems = await f.call('get', '/api/organizer/logs', { query: { filter: 'problems' } });
  assert.deepEqual(problems.body.entries.map(entry => entry.kind), ['skip']);
  assert.equal(problems.body.lines.length, 1, 'the raw lines follow the same filter');
  const searched = await f.call('get', '/api/organizer/logs', { query: { q: 'signal' } });
  assert.deepEqual(searched.body.entries.map(entry => entry.kind), ['import']);
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

// A download that is one loose video file sits in Share as "<release>.mkv", while the organizer
// logs the release without the extension; the exact comparison left every such skip out of
// "Needs review" (seen with "The Weight 2026 1080p WEB-DL HEVC x265 5.1 BONE.mkv").
test('a skipped loose video file in Share needs review; a folder must match its name exactly', async t => {
  const f = fixture(t, { logLines: [
    `${stamp(5)} [MOVIE] Found: The Weight 2026 1080p WEB-DL HEVC x265 5.1 BONE`,
    `${stamp(5)}   Parsed: title='The Weight', year=2026`,
    `${stamp(5)} SKIP: No confident OMDb match for: The Weight (2026)`,
    `${stamp(4)} [MOVIE] Found: Folder Film 2020 1080p`,
    `${stamp(4)}   Parsed: title='Folder Film', year=2020`,
    `${stamp(4)} SKIP: No confident OMDb match for: Folder Film (2020)`,
  ] });
  const share = path.join(f.dir, 'Share');
  fs.writeFileSync(path.join(share, 'The Weight 2026 1080p WEB-DL HEVC x265 5.1 BONE.mkv'), 'video');
  fs.mkdirSync(path.join(share, 'Folder Film 2020 1080p.mkv'));   // a folder is never stripped of a "video extension"
  const res = await f.call('get', '/api/organizer/fix-queue');
  const weight = res.body.queue.find(e => e.title === 'The Weight');
  assert.equal(weight.stillPresent, true, 'the loose file counts as present');
  assert.equal(res.body.queue.find(e => e.title === 'Folder Film').stillPresent, false);
  assert.equal(res.body.leftovers.some(l => /The Weight/.test(l.name)), false, 'and it is not also listed as an unexplained leftover');
});
