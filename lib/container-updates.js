// Keeps the Docker containers (VPN, qBittorrent, Cloudflare tunnel) on current versions. Docker only
// fetches a new version when told to, and nobody had since February 2026. One run: wait until nothing
// plays and nothing downloads, pull, switch only the services whose image changed, prove each switch
// worked and otherwise put the old version back. The result goes to container-updates.json, which
// the Dashboard reads (the app itself has no access to Docker). scripts/update-containers.js runs it
// weekly from a user timer.
const path = require('path');

const DEFAULT_TIMEOUTS = { health: 180_000, tunnel: 120_000, integration: 120_000, poll: 3_000 };
// Torrent states that move data on disk or over the network; a restart would interrupt them.
const ACTIVE_STATES = new Set(['downloading', 'forcedDL', 'metaDL', 'forcedMetaDL', 'allocating',
  'checkingDL', 'checkingUP', 'checkingResumeData', 'moving']);
const PREVIOUS_TAG = 'chochey-previous';
const IP = /^[0-9a-f.:]{3,45}$/i;

// 'lscr.io/linuxserver/qbittorrent:latest' -> 'lscr.io/linuxserver/qbittorrent'
function repository(ref) {
  const bare = ref.split('@')[0];
  const colon = bare.lastIndexOf(':');
  return colon > bare.lastIndexOf('/') ? bare.slice(0, colon) : bare;
}

function createContainerUpdates({
  run, composeDir, readinessUpdatedAt, isQuiet, writeStatus, sleep, log = console.log, now = Date.now,
  timeouts = {}, busyPollMs = 5 * 60_000, waitBudgetMs = 12 * 3600_000,
  vpn = 'gluetun', torrent = 'qbittorrent', tunnel = 'cloudflared',
}) {
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const docker = (args, opts = {}) => run('docker', args, { cwd: composeDir, ...opts });

  async function until(probe, ms) {
    const deadline = now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (now() >= deadline) return null;
      await sleep(t.poll);
    }
  }

  async function inspect(name) {
    const r = await docker(['inspect', name, '--format', '{{.Config.Image}}\t{{.Image}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.State.Running}}']);
    if (r.code !== 0) return null;
    const [ref, imageId, health, running] = r.stdout.trim().split('\t');
    return { ref, imageId, health: health || '', running: running === 'true' };
  }

  async function imageInfo(refOrId) {
    const r = await docker(['image', 'inspect', refOrId, '--format', '{{.Id}}\t{{.Created}}']);
    if (r.code !== 0) return null;
    const [id, created] = r.stdout.trim().split('\t');
    return { id, created: created || null };
  }

  // Every service in the compose project with the image its container runs right now.
  async function snapshot() {
    const ps = await docker(['compose', 'ps', '-a', '--format', '{{.Service}}\t{{.Name}}']);
    if (ps.code !== 0) throw Object.assign(new Error(`docker compose ps failed: ${(ps.stderr || '').trim()}`), { code: 'COMPOSE_UNREADABLE' });
    const rows = ps.stdout.split('\n').map(line => line.trim().split('\t')).filter(([service]) => service)
      .map(([service, name]) => ({ service, name: name || service })).sort((a, b) => a.service.localeCompare(b.service));
    const out = [];
    for (const row of rows) {
      const c = await inspect(row.name);
      if (!c) continue;
      const img = await imageInfo(c.imageId);
      out.push({ ...row, ...c, builtAt: img?.created || null });
    }
    return out;
  }

  async function publicIp(probe) {
    for (const url of ['https://api.ipify.org', 'https://icanhazip.com']) {
      const ip = (await probe(url)).trim();
      if (IP.test(ip)) return ip;
    }
    return '';
  }
  const hostIp = () => publicIp(async url => (await run('curl', ['-s', '--max-time', '10', url])).stdout || '');
  // Asked from inside qBittorrent's container, which has no network of its own (it uses the VPN's).
  const torrentIp = name => publicIp(async url => (await docker(['exec', name, 'sh', '-c',
    `curl -s --max-time 10 ${url} || wget -qO- -T 10 ${url}`])).stdout || '');

  async function waitForQuiet(wait) {
    const deadline = now() + waitBudgetMs;
    let q = await isQuiet();
    while (!q.quiet && wait && now() < deadline) {
      log(`waiting: ${q.reason}`);
      await sleep(busyPollMs);
      q = await isQuiet();
    }
    return q;
  }

  // Proves a switched group works. Returns null or an error code.
  async function check(group, byService, host, onLeak) {
    const has = s => group.includes(s);
    if (has(vpn) && !await until(async () => (await inspect(byService[vpn].name))?.health === 'healthy', t.health)) return 'VPN_NOT_HEALTHY';
    if (has(torrent)) {
      const name = byService[torrent].name;
      const ip = await until(() => torrentIp(name), t.health);
      if (!ip) return 'NO_VPN_CONNECTION';
      if (ip === host) { await onLeak(); return 'VPN_LEAK'; }
      const webui = await until(async () => (await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', 'http://127.0.0.1:8080/'])).stdout.trim() === '200', t.health);
      if (!webui) return 'QBITTORRENT_NOT_ANSWERING';
      // The app rewrites download-readiness.json only on a poll that reached qBittorrent.
      const since = now();
      if (!await until(async () => (await readinessUpdatedAt()) > since, t.integration)) return 'APP_LOST_QBITTORRENT';
    }
    if (has(tunnel)) {
      const connected = await until(async () => {
        const m = (await run('curl', ['-s', '--max-time', '5', 'http://127.0.0.1:20241/metrics'])).stdout || '';
        const line = m.split('\n').find(l => l.startsWith('cloudflared_tunnel_ha_connections'));
        return line && Number(line.trim().split(/\s+/).pop()) >= 1;
      }, t.tunnel);
      if (!connected) return 'TUNNEL_NOT_CONNECTED';
    }
    for (const s of group.filter(s => ![vpn, torrent, tunnel].includes(s))) {
      if (!await until(async () => (await inspect(byService[s].name))?.running, t.health)) return 'NOT_RUNNING';
    }
    return null;
  }

  const recreate = group => docker(['compose', 'up', '-d', '--force-recreate', ...group], { timeout: 10 * 60_000 });

  async function finish(result, rows, extra = {}) {
    const after = await snapshot().catch(() => []);
    const live = Object.fromEntries(after.map(c => [c.service, c]));
    const containers = rows.map(c => {
      const a = live[c.service] || {};
      const healthy = !c.error && !!a.running && (a.health === '' || a.health === 'healthy');
      return { name: c.name, image: c.ref, builtAt: (c.updated ? c.newBuiltAt : c.builtAt) || null,
        previousBuiltAt: c.updated ? c.builtAt : null, updated: !!c.updated, rolledBack: !!c.rolledBack,
        healthy, error: c.error || null };
    });
    const status = { version: 1, at: new Date(now()).toISOString(), ok: !['failed', 'rolled-back'].includes(result),
      result, reason: extra.reason || '', error: extra.error || null, containers };
    await writeStatus(status);
    log(`${result}${extra.reason ? `: ${extra.reason}` : ''}${extra.error ? ` (${extra.error})` : ''}`);
    return status;
  }

  async function update({ wait = false } = {}) {
    let q = await waitForQuiet(wait);
    let before = await snapshot();
    if (!q.quiet) return finish('busy', before, { reason: q.reason });
    const host = await hostIp();
    if (!host) return finish('failed', before, { error: 'NO_INTERNET', reason: 'this server could not reach the internet' });

    const pull = await docker(['compose', 'pull'], { timeout: 30 * 60_000 });
    if (pull.code !== 0) log(`docker compose pull exited ${pull.code}: ${(pull.stderr || '').trim().slice(-300)}`);
    const changed = [];
    for (const c of before) {
      const img = await imageInfo(c.ref);
      if (img && img.id !== c.imageId) changed.push(Object.assign(c, { newId: img.id, newBuiltAt: img.created }));
    }
    if (!changed.length) return pull.code === 0 ? finish('current', before) : finish('failed', before, { error: 'PULL_FAILED', reason: 'new versions could not be downloaded' });

    // Downloading can take minutes; someone may have pressed play meanwhile.
    q = await waitForQuiet(wait);
    if (!q.quiet) {
      for (const c of changed) await docker(['tag', c.imageId, c.ref]);
      return finish('busy', before, { reason: q.reason });
    }

    const byService = Object.fromEntries(before.map(c => [c.service, c]));
    const names = new Set(changed.map(c => c.service));
    // qBittorrent uses the VPN container's network, so a new VPN means a new qBittorrent container too.
    const groups = [];
    if (names.has(vpn)) groups.push([vpn, ...(byService[torrent] ? [torrent] : [])]);
    else if (names.has(torrent)) groups.push([torrent]);
    for (const s of names) if (s !== vpn && s !== torrent) groups.push([s]);

    let rolledBack = false, failed = false;
    for (const group of groups) {
      const mine = changed.filter(c => group.includes(c.service));
      log(`switching ${mine.map(c => `${c.service} (built ${c.builtAt?.slice(0, 10)} -> ${c.newBuiltAt?.slice(0, 10)})`).join(', ')}`);
      const stopTorrent = () => docker(['stop', byService[torrent].name]);
      const up = await recreate(group);
      const error = up.code !== 0 ? 'RECREATE_FAILED' : await check(group, byService, host, stopTorrent);
      if (!error) { for (const c of mine) c.updated = true; continue; }

      log(`${group.join(' + ')} failed its check (${error}); putting the previous version back`);
      for (const c of mine) { c.error = error; c.rolledBack = true; await docker(['tag', c.imageId, c.ref]); }
      await recreate(group);
      const again = await check(group, byService, host, stopTorrent);
      if (again) {
        failed = true;
        for (const c of mine) c.error = `${error}; previous version also failed: ${again}`;
        log(`the previous version failed too (${again})${again === 'VPN_LEAK' ? '; qBittorrent stays stopped' : ''}`);
      } else rolledBack = true;
    }

    // Keep each replaced version under one extra tag for a manual rollback; drop the one it replaces.
    for (const c of changed.filter(c => c.updated)) {
      const keep = `${repository(c.ref)}:${PREVIOUS_TAG}`;
      const older = await imageInfo(keep);
      await docker(['tag', c.imageId, keep]);
      if (older && older.id !== c.imageId && older.id !== c.newId) await docker(['image', 'rm', older.id]);
    }

    const result = failed ? 'failed' : rolledBack ? 'rolled-back' : 'updated';
    return finish(result, before, failed ? { error: 'STILL_BROKEN' } : {});
  }

  async function status() {
    return finish('checked', await snapshot());
  }

  return { update, status };
}

// Quiet = nobody played anything for `idleMinutes`, no torrent is moving data, and the app has
// heard from qBittorrent within `staleMs` (otherwise the check after a switch proves nothing).
async function quietCheck({ dataDir, readdir, readJSON, now = Date.now, idleMinutes = 30, staleMs = 2 * 60_000 }) {
  let last = 0;
  for (const f of await readdir(dataDir)) {
    if (!/^profile_.*\.json$/.test(f)) continue;
    const profile = await readJSON(path.join(dataDir, f)).catch(() => null);
    for (const e of Object.values(profile?.progress || {})) last = Math.max(last, e?.updatedAt || 0);
  }
  const playedMin = Math.floor((now() - last) / 60_000);
  if (playedMin < idleMinutes) return { quiet: false, reason: `something was played ${playedMin} min ago` };
  const readiness = await readJSON(path.join(dataDir, 'download-readiness.json')).catch(() => null);
  const age = now() - (readiness?.updatedAt || 0);
  if (!readiness || age > staleMs) {
    return { quiet: false, reason: `the app has not heard from qBittorrent for ${readiness ? Math.floor(age / 60_000) : '?'} min` };
  }
  const active = (readiness.entries || []).filter(e => ACTIVE_STATES.has(e.state)).length;
  if (active) return { quiet: false, reason: `${active} download${active === 1 ? ' is' : 's are'} in progress` };
  return { quiet: true, reason: '' };
}

module.exports = createContainerUpdates;
module.exports.quietCheck = quietCheck;
module.exports.repository = repository;
