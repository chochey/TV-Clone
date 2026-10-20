// The app restarting itself. Two callers: an admin pressing "Restart app", and the deploy
// script, which runs as a user that cannot restart services, so it drops a `restart-request`
// file in the data dir instead. Either way the process shuts down cleanly and systemd
// (Restart=always) brings it back on the revision now checked out.
//
// Loops are the thing to fear: a request file left behind would restart every boot. So a
// file is acted on only when it is newer than this boot, and it is removed before shutting down.
const fs = require('fs');
const path = require('path');

const FILE = 'restart-request';

module.exports = function createSelfRestart({
  dataDir, shutdown, log = () => {}, bootAt = Date.now(), pollMs = 2000,
  setTimeout: later = setTimeout, setInterval: every = setInterval, clearInterval: stopEvery = clearInterval,
}) {
  const file = path.join(dataDir, FILE);
  let pending = false;
  let timer = null;

  function remove() {
    try { fs.unlinkSync(file); } catch { /* already gone, or not ours to remove */ }
  }

  // Answer the HTTP request (or finish the log line) before going down.
  function request(reason) {
    if (pending) return false;
    pending = true;
    log(`restart requested by ${reason}; shutting down for systemd to bring the app back`);
    later(() => shutdown(), 300);
    return true;
  }

  function poll() {
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (stat.mtimeMs <= bootAt) { remove(); return; }   // left over from before this boot
    let reason = 'the deploy script';
    try { reason = fs.readFileSync(file, 'utf8').trim() || reason; } catch { /* unreadable: still a request */ }
    remove();
    request(reason);
  }

  function start() {
    if (timer !== null) return;
    poll();
    timer = every(poll, pollMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() { if (timer !== null) { stopEvery(timer); timer = null; } }

  return { request, start, stop, file };
};
