// Proof that the app restarted after we asked it to. The old process answers /api/health
// at once, so "health is ready" proves nothing; a restart shows as an uptime lower than the
// one read before the request (the new process starts near zero), or, for a server that does
// not report uptime, as health failing at least once and then answering again.
const defaultHealth = () => fetch('/api/health', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });

export async function waitForRestart({
  uptimeBefore, health = defaultHealth, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now, timeoutMs = 90000, intervalMs = 1500,
} = {}) {
  const started = now();
  let wasDown = false;
  while (now() - started < timeoutMs) {
    await sleep(intervalMs);
    let reading;
    try { reading = await health(); } catch { wasDown = true; continue; }
    const uptime = Number(reading?.uptime);
    if (Number.isFinite(uptime) && Number.isFinite(Number(uptimeBefore)) && uptimeBefore !== null && uptime < Number(uptimeBefore)) return 'restarted';
    if (wasDown && (reading?.ready || reading?.status === 'ready')) return 'restarted';
  }
  return 'not-restarted';
}

// The uptime to compare against, read before asking for the restart; null when unknown.
export async function currentUptime(health = defaultHealth) {
  try { const h = await health(); const u = Number(h?.uptime); return Number.isFinite(u) ? u : null; } catch { return null; }
}
