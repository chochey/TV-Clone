// Storage health for the pooled USB drives (and the OS disk): per-branch
// fill levels, SMART status via smartctl, a fill-rate projection from daily
// usage snapshots, and state-transition alerts pushed into the notification
// history. Factory module.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SMARTCTL = process.env.SMARTCTL_BIN || '/usr/sbin/smartctl';

function execJson(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // smartctl exits nonzero for warnings/failing drives but still emits JSON
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// Pool branches from the fstab mergerfs line (colon-separated, \040 = space).
function branchesFromFstab(fstab) {
  for (const line of fstab.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#') || !/\smergerfs\s/.test(t)) continue;
    return t.split(/\s+/)[0].split(':').map((p) => p.replace(/\\040/g, ' '));
  }
  return [];
}

// Linear fill projection from usage snapshots: bytes/day over the window.
function projectDaysLeft(history, avail) {
  if (!Array.isArray(history) || history.length < 2 || !avail) return null;
  const win = history.slice(-30);
  const first = win[0], last = win[win.length - 1];
  const days = (last.ts - first.ts) / 86400000;
  if (days < 1) return null;
  const perDay = (last.used - first.used) / days;
  if (perDay <= 0) return null; // shrinking or flat — no ETA
  return { daysLeft: Math.round(avail / perDay), perDay };
}

module.exports = function createStorageHealth({ DATA_DIR, loadJSON, saveJSON, onAlert, poolMount = '/mnt/media' }) {
  const HISTORY_FILE = path.join(DATA_DIR, 'storage_history.json');
  const ALERT_STATE_FILE = path.join(DATA_DIR, 'storage_alerts.json');
  let history = loadJSON(HISTORY_FILE, []);
  if (!Array.isArray(history)) history = [];
  let alertState = loadJSON(ALERT_STATE_FILE, {});

  let smartCache = { ts: 0, byDev: {} };

  async function dfEntry(target) {
    const out = await exec('df', ['-B1', '--output=source,size,used,avail,pcent,target', target]);
    if (!out) return null;
    const line = out.trim().split('\n').pop();
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) return null;
    return { source: m[1], size: +m[2], used: +m[3], avail: +m[4], pct: +m[5], mount: m[6] };
  }

  // /dev/sdb2 -> /dev/sdb, /dev/nvme0n1p2 -> /dev/nvme0n1
  function baseDevice(source) {
    if (!source || !source.startsWith('/dev/')) return null;
    if (source.includes('nvme')) return source.replace(/p\d+$/, '');
    return source.replace(/\d+$/, '');
  }

  async function readSmart(dev) {
    const d = await execJson('sudo', ['-n', SMARTCTL, '-H', '-A', dev, '--json']);
    if (!d) return { ok: false };
    const out = {
      ok: true,
      passed: d.smart_status ? !!d.smart_status.passed : null,
      tempC: d.temperature?.current ?? null,
      powerOnHours: d.power_on_time?.hours ?? null,
      reallocated: null, pending: null, uncorrectable: null,
    };
    for (const a of d.ata_smart_attributes?.table || []) {
      if (a.id === 5) out.reallocated = a.raw?.value ?? null;
      if (a.id === 197) out.pending = a.raw?.value ?? null;
      if (a.id === 198) out.uncorrectable = a.raw?.value ?? null;
    }
    // NVMe exposes a different block
    const nv = d.nvme_smart_health_information_log;
    if (nv) {
      out.mediaErrors = nv.media_errors ?? null;
      out.percentUsed = nv.percentage_used ?? null;
    }
    return out;
  }

  async function snapshot() {
    // Branches + pool + OS disk
    let branches = [];
    try { branches = branchesFromFstab(fs.readFileSync('/etc/fstab', 'utf8')); } catch {}
    const targets = [
      { label: 'Pool', mount: poolMount, kind: 'pool' },
      ...branches.map((b) => ({ label: path.basename(b), mount: b, kind: 'branch' })),
      { label: 'OS disk', mount: '/', kind: 'os' },
    ];

    const rows = [];
    for (const t of targets) {
      const df = await dfEntry(t.mount);
      if (!df) continue;
      rows.push({ ...t, ...df, dev: t.kind === 'pool' ? null : baseDevice(df.source) });
    }

    // SMART (cached 5 min — one smartctl run per drive per window)
    if (Date.now() - smartCache.ts > 5 * 60 * 1000) {
      const byDev = {};
      for (const r of rows) {
        if (r.dev && !byDev[r.dev]) byDev[r.dev] = await readSmart(r.dev);
      }
      smartCache = { ts: Date.now(), byDev };
    }
    for (const r of rows) r.smart = r.dev ? smartCache.byDev[r.dev] || null : null;

    const pool = rows.find((r) => r.kind === 'pool') || null;
    if (pool) pool.projection = projectDaysLeft(history, pool.avail);
    return { pool, drives: rows.filter((r) => r.kind !== 'pool') };
  }

  // Daily usage snapshot for the projection (skip if one landed recently).
  function recordUsage(pool) {
    if (!pool) return;
    const last = history[history.length - 1];
    if (last && Date.now() - last.ts < 20 * 60 * 60 * 1000) return;
    history.push({ ts: Date.now(), used: pool.used, size: pool.size });
    if (history.length > 400) history = history.slice(-400);
    saveJSON(HISTORY_FILE, history);
  }

  // State-transition alerts: fire when a condition first becomes true (or a
  // sector count increases), stay quiet while it persists, reset when clear.
  function checkAlerts({ pool, drives }) {
    const fired = [];
    const fire = (key, title, body) => {
      fired.push({ key, title, body });
      alertState[key] = { active: true, ts: Date.now() };
    };
    const clear = (key) => { if (alertState[key]?.active) alertState[key] = { active: false, ts: Date.now() }; };
    const isActive = (key) => !!alertState[key]?.active;

    for (const d of drives) {
      const name = d.label;
      const s = d.smart;
      if (s && s.ok) {
        if (s.passed === false) {
          if (!isActive(`smartfail:${d.dev}`)) fire(`smartfail:${d.dev}`, 'Drive failing SMART', `${name} (${d.dev}) reports SMART FAILED — back up and replace it`);
        } else clear(`smartfail:${d.dev}`);

        for (const [attr, label] of [['reallocated', 'reallocated sectors'], ['pending', 'pending sectors'], ['uncorrectable', 'uncorrectable sectors']]) {
          const v = s[attr];
          if (v == null) continue;
          const prevKey = `${attr}:${d.dev}`;
          const prev = alertState[prevKey]?.value ?? 0;
          if (v > 0 && v > prev) {
            fire(prevKey, 'Drive health warning', `${name} (${d.dev}): ${v} ${label}`);
            alertState[prevKey] = { active: true, ts: Date.now(), value: v };
          }
        }

        if (s.tempC != null) {
          if (s.tempC >= 60) {
            if (!isActive(`temp:${d.dev}`)) fire(`temp:${d.dev}`, 'Drive running hot', `${name} (${d.dev}) is at ${s.tempC}°C`);
          } else if (s.tempC <= 55) clear(`temp:${d.dev}`);
        }
      }
      if (d.kind === 'branch') {
        if (d.pct >= 95) {
          if (!isActive(`full:${d.mount}`)) fire(`full:${d.mount}`, 'Drive nearly full', `${name} is at ${d.pct}% (${(d.avail / 1e9).toFixed(0)} GB left)`);
        } else if (d.pct <= 93) clear(`full:${d.mount}`);
      }
    }
    if (pool) {
      if (pool.pct >= 90) {
        if (!isActive('poolfull')) {
          const eta = pool.projection ? ` — full in ~${pool.projection.daysLeft} days at the current rate` : '';
          fire('poolfull', 'Storage pool nearly full', `The pool is at ${pool.pct}% (${(pool.avail / 1e12).toFixed(2)} TB left)${eta}`);
        }
      } else if (pool.pct <= 88) clear('poolfull');
    }

    if (fired.length) saveJSON(ALERT_STATE_FILE, alertState);
    for (const f of fired) { try { onAlert(f); } catch {} }
    return fired;
  }

  async function tick() {
    const snap = await snapshot();
    recordUsage(snap.pool);
    checkAlerts(snap);
    return snap;
  }

  return { snapshot, tick, projectDaysLeft, branchesFromFstab };
};

module.exports.projectDaysLeft = projectDaysLeft;
module.exports.branchesFromFstab = branchesFromFstab;
