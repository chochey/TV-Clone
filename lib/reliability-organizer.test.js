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
