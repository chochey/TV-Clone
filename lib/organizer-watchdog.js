// Organizer watchdog: the media-organizer has frozen silently before —
// process alive, log dead. Since organizer-watch (and therefore all
// auto-rescans) keys off that log, a frozen organizer means new content
// stays invisible. Watch the log's timestamps; when they go stale while
// systemd still reports the service active, bounce it. Factory module.
const fs = require('fs');

const TS_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/;
const TAIL_BYTES = 64 * 1024;

// Last timestamp of ANY log line (heartbeat or activity) — a busy organizer
// may skip heartbeats but still logs what it's doing.
function parseLastTimestamp(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(TS_RE);
    if (m) {
      const [, Y, Mo, D, H, Mi, S] = m;
      return new Date(+Y, +Mo - 1, +D, +H, +Mi, +S).getTime();
    }
  }
  return 0;
}

function isStale(lastTs, nowMs, staleMs) {
  if (!lastTs) return false; // unreadable/empty log: not evidence of a freeze
  return nowMs - lastTs > staleMs;
}

module.exports = function createOrganizerWatchdog({
  logPath,
  isActive,   // async () => boolean — systemd thinks the service is running
  restart,    // async () => {ok, stderr}
  onRestart,  // (ageMs, result) => void — logging/recording hook
  checkMs = 5 * 60 * 1000,
  staleMs = 15 * 60 * 1000,
  cooldownMs = 30 * 60 * 1000,
}) {
  let timer = null;
  let lastRestartAt = 0;

  function readTail() {
    let st;
    try { st = fs.statSync(logPath); } catch { return ''; }
    const start = Math.max(0, st.size - TAIL_BYTES);
    try {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch { return ''; }
  }

  async function check(nowMs = Date.now()) {
    const lastTs = parseLastTimestamp(readTail());
    if (!isStale(lastTs, nowMs, staleMs)) return { stale: false, lastTs };
    const ageMs = nowMs - lastTs;
    // Deliberately stopped is not frozen — never fight the operator.
    if (!(await isActive())) return { stale: true, lastTs, skipped: 'inactive' };
    if (nowMs - lastRestartAt < cooldownMs) return { stale: true, lastTs, skipped: 'cooldown' };
    lastRestartAt = nowMs;
    const result = await restart();
    try { onRestart?.(ageMs, result); } catch {}
    return { stale: true, lastTs, restarted: true, ok: result.ok };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { check().catch(() => {}); }, checkMs);
    timer.unref();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, check };
};

// Pure helpers exported for unit tests.
module.exports.parseLastTimestamp = parseLastTimestamp;
module.exports.isStale = isStale;
