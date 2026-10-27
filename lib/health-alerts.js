// Nightly and weekly jobs leave receipts that the Dashboard shows (lib/dashboard-jobs.js), but nobody
// looks every day. Once an hour this reads the same sources and rings the notification bell once per
// incident, for admins and Dashboard users: a failed backup, backups gone stale, a container update
// that failed or rolled back, a late weekly update, a SnapRAID sync that refused or failed. The
// recovery is said once too. What was announced is remembered on disk, so a restart does not repeat it.
const DAY_H = 24;

// Plain words for the container updater's codes (the Dashboard card uses the same list).
const PROBLEM = {
  VPN_LEAK: 'downloads went out without the VPN, so qBittorrent was stopped at once',
  VPN_NOT_HEALTHY: 'the VPN did not connect', NO_VPN_CONNECTION: 'qBittorrent could not get online through the VPN',
  QBITTORRENT_NOT_ANSWERING: 'qBittorrent did not answer', APP_LOST_QBITTORRENT: 'ChocheyTV could not reach qBittorrent',
  TUNNEL_NOT_CONNECTED: 'the tunnel did not reconnect', RECREATE_FAILED: 'the new version would not start',
  NOT_RUNNING: 'it did not keep running', SETTINGS_COPY_FAILED: 'its settings could not be copied first, so it was not switched',
  SETTINGS_RESTORE_FAILED: 'its settings could not be put back (the copy is kept)',
};
const problem = error => String(error).split('; ').map(part => {
  const again = part.match(/^previous version also failed: (.*)$/);
  return again ? `and the old version failed too (${PROBLEM[again[1]] || again[1]})` : (PROBLEM[part] || part);
}).join(', ');
const days = hours => Math.max(1, Math.round(hours / DAY_H));

module.exports = function createHealthAlerts({ jobs, notify, loadJSON, saveJSON, stateFile, now = Date.now, log = console.log }) {
  const state = { backup: {}, containers: {}, snapraid: {}, ...loadJSON(stateFile, {}) };
  // A receipt that reports a failed run carries its own `error`; an unreadable source has no `at` and
  // `error: 'unavailable'` (lib/dashboard-jobs.js `safe`). Only the latter is skipped.
  const usable = source => !!source && !source.missing && !(source.error === 'unavailable' && !source.at);
  const say = (title, body = '') => { log(`[health] ${title}${body ? ` — ${body}` : ''}`); notify({ type: 'health', title, body, audience: 'dashboard' }); };

  function backup(b) {
    const s = state.backup;
    if (!b.ok) {
      if (s.failedAt !== b.at) { say("Last night's backup failed", b.error ? `Reason: ${b.error}. See the Dashboard's Backups card.` : "See the Dashboard's Backups card."); s.failedAt = b.at; }
    } else if (s.failedAt && b.at !== s.failedAt) {
      say('Backups are working again', 'The latest backup completed and verified.');
      delete s.failedAt;
    }
    if (b.stale && !s.staleSince) { say(`No backup for ${days(b.ageHours)} days`, 'The nightly backup has not completed. See the Dashboard.'); s.staleSince = now(); }
    else if (!b.stale && s.staleSince) { say('Backups are running again'); delete s.staleSince; }
  }

  function containers(c) {
    const s = state.containers;
    if ((c.result === 'failed' || c.result === 'rolled-back') && s.at !== c.at) {
      const what = (c.containers || []).filter(x => x.error).map(x => `${x.name}: ${problem(x.error)}`).join('. ');
      say(c.result === 'rolled-back' ? 'Container update rolled back' : 'Container update failed',
        [what, c.reason].filter(Boolean).join(' ') || "See the Dashboard's Containers card.");
      s.at = c.at;
    }
    if (c.late && !s.lateSince) { say(`The weekly container update has not run for ${days(c.hoursAgo)} days`, 'Check the timer: systemctl --user list-timers chochey-container-update.timer'); s.lateSince = now(); }
    else if (!c.late && s.lateSince) { say('The weekly container update is running again'); delete s.lateSince; }
  }

  function snapraid(r) {
    const s = state.snapraid;
    if (!r.ok && s.at !== r.at) {
      if (r.result === 'refused') {
        say(`SnapRAID did not sync: ${r.deleted} files vanished`, `More than the nightly limit vanished since the last sync, so parity was left as it was. If that was intended, run: sudo snapraid-nightly.sh --force. If not, check the pool before the files are gone from parity too.`);
      } else {
        say('SnapRAID sync failed', `Reason: ${r.error || r.result}. See /var/log/snapraid-nightly.log.`);
      }
      s.at = r.at;
    } else if (r.ok && s.at && r.at !== s.at) { say('SnapRAID is syncing again'); delete s.at; }
    if (r.late && !s.lateSince) { say(`SnapRAID has not synced for ${days(r.hoursAgo)} days`); s.lateSince = now(); }
    else if (!r.late && s.lateSince) delete s.lateSince;
  }

  async function check() {
    const snap = await jobs.snapshot();
    if (usable(snap.backup) && snap.backup.at) backup(snap.backup);
    if (usable(snap.containers) && snap.containers.at) containers(snap.containers);
    if (usable(snap.snapraid) && snap.snapraid.at) snapraid(snap.snapraid);
    saveJSON(stateFile, state);
  }

  function start({ firstDelayMs = 3 * 60_000, everyMs = 60 * 60_000 } = {}) {
    const run = () => check().catch(e => log(`[health] check failed: ${e.message}`));
    const first = setTimeout(run, firstDelayMs); first.unref?.();
    const timer = setInterval(run, everyMs); timer.unref?.();
    return () => { clearTimeout(first); clearInterval(timer); };
  }

  return { check, start };
};
