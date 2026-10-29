// Nightly and weekly jobs leave receipts; the Dashboard shows them, but nobody looks every day. The
// health check reads the same sources once an hour and rings the notification bell once per incident:
// a failed backup, backups gone stale, a container update that failed or rolled back, a late weekly
// update, a SnapRAID sync that refused or failed. Recoveries are said once too.
const test = require('node:test');
const assert = require('node:assert/strict');
const createHealthAlerts = require('./health-alerts');

const ok = { backup: { at: 1, ok: true, verified: true, stale: false, ageHours: 5 }, containers: { at: 1, ok: true, result: 'current', late: false, hoursAgo: 20, containers: [] }, snapraid: { missing: true } };

function fixture(sequence, { saved = {} } = {}) {
  const notes = [];
  let store = saved, i = 0;
  const alerts = createHealthAlerts({
    jobs: { snapshot: async () => sequence[Math.min(i++, sequence.length - 1)] },
    notify: spec => notes.push(spec), loadJSON: () => store, saveJSON: (_f, v) => { store = JSON.parse(JSON.stringify(v)); },
    stateFile: '/x/health-alerts.json', now: () => Date.parse('2026-10-27T10:00:00Z'), log() {},
  });
  return { alerts, notes, store: () => store, titles: () => notes.map(n => n.title) };
}

test('a failed backup is announced once, and the next good one says backups work again', async () => {
  const failed = { ...ok, backup: { at: 2, ok: false, error: 'BACKUP_DIRECTORY', stale: false, ageHours: 7 } };
  const good = { ...ok, backup: { at: 3, ok: true, verified: true, stale: false, ageHours: 6 } };
  const f = fixture([failed, failed, good, good]);
  for (let n = 0; n < 4; n++) await f.alerts.check();
  assert.deepEqual(f.titles(), ["Last night's backup failed", 'Backups are working again']);
  assert.match(f.notes[0].body, /BACKUP_DIRECTORY/);
  assert.ok(f.notes.every(n => n.type === 'health' && n.audience === 'dashboard'));
});

test('backups gone stale are announced once while stale, and once more when they are back', async () => {
  const stale = { ...ok, backup: { at: 1, ok: true, verified: true, stale: true, ageHours: 74 } };
  const f = fixture([stale, stale, stale, ok, ok]);
  for (let n = 0; n < 5; n++) await f.alerts.check();
  assert.deepEqual(f.titles(), ['No backup for 3 days', 'Backups are running again']);
});

test('a container update that rolled back or failed is announced once with what went wrong; a late weekly update too', async () => {
  const rolled = { ...ok, containers: { at: 5, ok: false, result: 'rolled-back', reason: '', error: null, late: false, hoursAgo: 2,
    containers: [{ name: 'qbittorrent', error: 'APP_LOST_QBITTORRENT' }, { name: 'cloudflared', error: null }] } };
  const late = { ...ok, containers: { ...ok.containers, late: true, hoursAgo: 230 } };
  const f = fixture([rolled, rolled, late, late, ok]);
  for (let n = 0; n < 5; n++) await f.alerts.check();
  assert.deepEqual(f.titles(), ['Container update rolled back', 'The weekly container update has not run for 10 days', 'The weekly container update is running again']);
  assert.match(f.notes[0].body, /qbittorrent: ChocheyTV could not reach qBittorrent/);
  const failed = fixture([{ ...ok, containers: { at: 6, ok: false, result: 'failed', error: 'STILL_BROKEN', late: false, hoursAgo: 1, containers: [{ name: 'gluetun', error: 'VPN_LEAK; previous version also failed: VPN_LEAK' }] } }]);
  await failed.alerts.check();
  assert.deepEqual(failed.titles(), ['Container update failed']);
  assert.match(failed.notes[0].body, /gluetun: downloads went out without the VPN.*old version failed too/);
});

test('a SnapRAID sync that refused or failed is announced once, with the way out', async () => {
  const refused = { ...ok, snapraid: { at: 9, ok: false, result: 'refused', error: 'TOO_MANY_DELETED', deleted: 450, late: false, hoursAgo: 6 } };
  const f = fixture([refused, refused]);
  await f.alerts.check(); await f.alerts.check();
  assert.deepEqual(f.titles(), ['SnapRAID did not sync: 450 files vanished']);
  assert.match(f.notes[0].body, /--force/);
  const broken = fixture([{ ...ok, snapraid: { at: 10, ok: false, result: 'failed', error: 'SYNC_FAILED', deleted: 0, late: false, hoursAgo: 6 } }]);
  await broken.alerts.check();
  assert.deepEqual(broken.titles(), ['SnapRAID sync failed']);
  // The reason in words, not the script's code (the first live failure rang "Reason: SYNC_FAILED").
  assert.match(broken.notes[0].body, /The sync itself failed/);
  assert.doesNotMatch(broken.notes[0].body, /SYNC_FAILED/);
  // Files changing under a running sync is not a broken pool; the job re-ran once and will try again tonight.
  const changing = fixture([{ ...ok, snapraid: { at: 11, ok: false, result: 'failed', error: 'FILES_CHANGED', deleted: 1, late: false, hoursAgo: 6, retried: true } }]);
  await changing.alerts.check();
  assert.deepEqual(changing.titles(), ['SnapRAID could not finish its sync']);
  assert.match(changing.notes[0].body, /Files kept changing while it ran.*tonight/);
});

test('what was already announced stays announced across restarts, and unreadable sources are left alone', async () => {
  const failed = { ...ok, backup: { at: 2, ok: false, error: 'X', stale: false, ageHours: 7 } };
  const first = fixture([failed]);
  await first.alerts.check();
  const second = fixture([failed, { ...ok, backup: { error: 'unavailable' }, containers: { missing: true } }], { saved: first.store() });
  await second.alerts.check(); await second.alerts.check();
  assert.deepEqual(second.titles(), []);
});
