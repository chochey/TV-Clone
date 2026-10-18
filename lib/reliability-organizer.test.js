const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { organizerLogStatus } = require('./reliability');

function files(t, { logAgeMs, status }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-organizer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'media-organizer.log'), statusFile = path.join(dir, 'organizer-status.json');
  fs.writeFileSync(log, '[2026-10-18 04:31:00] Still watching...\n');
  const when = (Date.now() - logAgeMs) / 1000; fs.utimesSync(log, when, when);
  if (status) fs.writeFileSync(statusFile, JSON.stringify({ version: 1, pid: 1, startedAt: Date.now() - 3600_000, scans: 9, ...status }));
  return { log, statusFile };
}

test('an hour-quiet log is fine when the status file shows the organizer scanning', t => {
  // Regression: the watchdog unit "failed" every minute since late September on this warning alone.
  const f = files(t, { logAgeMs: 50 * 60_000, status: { updatedAt: Date.now() - 10_000, activity: { state: 'idle' }, lastScan: { at: Date.now() - 20_000 } } });
  const result = organizerLogStatus(f.log, f.statusFile);
  assert.equal(result.ok, true); assert.equal(result.warning, '');
});

test('a stopped organizer is still reported, from the status file', t => {
  const f = files(t, { logAgeMs: 50 * 60_000, status: { updatedAt: Date.now() - 40 * 60_000, activity: { state: 'idle' }, lastScan: { at: Date.now() - 40 * 60_000 } } });
  const result = organizerLogStatus(f.log, f.statusFile);
  assert.equal(result.ok, false); assert.match(result.warning, /not (scanned|changed) recently/);
});

test('without a status file the log age decides, as before', t => {
  assert.equal(organizerLogStatus(files(t, { logAgeMs: 50 * 60_000 }).log, '/nonexistent/status.json').ok, false);
  assert.equal(organizerLogStatus(files(t, { logAgeMs: 60_000 }).log, '/nonexistent/status.json').ok, true);
});

test('a separate live install points the maintenance scripts at its data and scratch folders', t => {
  const { getSettings } = require('./reliability');
  const saved = { ...process.env };
  t.after(() => { for (const key of ['TVCLONE_DATA_DIR', 'TVCLONE_TRANSCODE_DIR']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  delete process.env.TVCLONE_DATA_DIR; delete process.env.TVCLONE_TRANSCODE_DIR;
  let settings = getSettings('/repo');
  assert.equal(settings.dataDir, '/repo/data'); assert.equal(settings.transcodeRoot, '/repo');
  process.env.TVCLONE_DATA_DIR = '/srv/chocheytv/data'; process.env.TVCLONE_TRANSCODE_DIR = '/srv/chocheytv/transcode_tmp';
  settings = getSettings('/srv/chocheytv/app');
  assert.equal(settings.dataDir, '/srv/chocheytv/data');
  assert.equal(settings.transcodeRoot, '/srv/chocheytv', 'stale transcode sessions are cleaned where they are written');
});

test('the minute watchdog warns while the data disk is nearly full', () => {
  const { diskSpaceStatus } = require('./reliability');
  const statfs = free => () => ({ bavail: free / 4096, bsize: 4096 });
  assert.deepEqual(diskSpaceStatus('/srv/chocheytv/data', { statfs: statfs(40e9) }), { ok: true, path: '/srv/chocheytv/data', freeGB: 40, warning: '' });
  const low = diskSpaceStatus('/srv/chocheytv/data', { statfs: statfs(3e9) });
  assert.equal(low.ok, false); assert.match(low.warning, /only 3 GB free/);
  assert.equal(diskSpaceStatus('/missing', { statfs: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } }).ok, false);
});
