const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createWatchdog = require('./organizer-watchdog');
const { parseLastTimestamp, isStale } = createWatchdog;

test('parseLastTimestamp: newest timestamped line wins, trailing junk ignored', () => {
  const ts = parseLastTimestamp([
    '[2026-07-06 10:00:00] Watching /mnt/media/Share (polling every 30s)',
    '[2026-07-06 10:05:30] Still watching...',
    'not a timestamped line',
    '',
  ].join('\n'));
  assert.equal(ts, new Date(2026, 6, 6, 10, 5, 30).getTime());
});

test('parseLastTimestamp: empty/garbage text gives 0', () => {
  assert.equal(parseLastTimestamp(''), 0);
  assert.equal(parseLastTimestamp('no timestamps here\nat all'), 0);
});

test('isStale: respects threshold and never flags an unreadable log', () => {
  const now = Date.now();
  assert.equal(isStale(now - 16 * 60000, now, 15 * 60000), true);
  assert.equal(isStale(now - 5 * 60000, now, 15 * 60000), false);
  assert.equal(isStale(0, now, 15 * 60000), false); // no evidence, no restart
});

function writeLog(dir, ageMs) {
  const p = path.join(dir, 'organizer.log');
  const d = new Date(Date.now() - ageMs);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  fs.writeFileSync(p, `[${stamp}] Still watching...\n`);
  return p;
}

test('check: fresh log does not restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  let restarts = 0;
  const wd = createWatchdog({
    logPath: writeLog(dir, 60 * 1000),
    isActive: async () => true,
    restart: async () => { restarts++; return { ok: true }; },
  });
  const r = await wd.check();
  assert.equal(r.stale, false);
  assert.equal(restarts, 0);
});

test('check: stale log + active service restarts once, then cooldown holds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  let restarts = 0;
  const wd = createWatchdog({
    logPath: writeLog(dir, 20 * 60 * 1000),
    isActive: async () => true,
    restart: async () => { restarts++; return { ok: true }; },
    onRestart: (ageMs) => assert.ok(ageMs > 15 * 60 * 1000),
  });
  const r1 = await wd.check();
  assert.equal(r1.restarted, true);
  const r2 = await wd.check();
  assert.equal(r2.skipped, 'cooldown');
  assert.equal(restarts, 1);
});

test('check: stale log but stopped service is left alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  let restarts = 0;
  const wd = createWatchdog({
    logPath: writeLog(dir, 20 * 60 * 1000),
    isActive: async () => false,
    restart: async () => { restarts++; return { ok: true }; },
  });
  const r = await wd.check();
  assert.equal(r.skipped, 'inactive');
  assert.equal(restarts, 0);
});

test('check: missing log file never restarts', async () => {
  let restarts = 0;
  const wd = createWatchdog({
    logPath: '/nonexistent/organizer.log',
    isActive: async () => true,
    restart: async () => { restarts++; return { ok: true }; },
  });
  const r = await wd.check();
  assert.equal(r.stale, false);
  assert.equal(restarts, 0);
});
