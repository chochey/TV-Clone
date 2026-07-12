// Watch the media-organizer log and trigger a library rescan when it files a
// new title. The media folders are on fuse.mergerfs, where fs.watch/inotify
// does NOT see writes — so watching the folders is useless. The organizer log
// is on local ext4 and gets a "Moved -> " line per filed file, so we watch it
// instead. Debounced so a burst of episodes coalesces into one rescan.
const fs = require('fs');

const MOVE_RE = /Moved -> |Deleted source folder/;
// Placement failures: the organizer gives up on a title and it stays stuck
// in the Share folder. Surfaced so admins hear about it instead of finding
// out weeks later when a movie is "missing". Covers bad OMDb matches,
// unparseable names, and packs with no episode-numbered files (the Grimm
// season-pack case).
const FAIL_RE = /SKIP: No (confident )?OMDb match|SKIP: No files with episode numbers found|SKIP: Could not parse title/;

module.exports = function createOrganizerWatch({ logPath, onMove, onAttention, debounceMs = 15000, retryMs = 30000 }) {
  // Floor low enough for fast tests but high enough to prevent a busy-loop.
  const debounce = Math.max(50, parseInt(debounceMs, 10) || 15000);
  let watcher = null;
  let retryTimer = null;
  let debounceTimer = null;
  let attentionTimer = null;
  let lastSize = 0;
  let closed = false;

  function readNewLines() {
    let st;
    try { st = fs.statSync(logPath); } catch { return; }
    // Truncated/rotated: start over from the top.
    if (st.size < lastSize) lastSize = 0;
    if (st.size === lastSize) return;
    let text = '';
    try {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(st.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { return; }
    lastSize = st.size;
    if (MOVE_RE.test(text)) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { try { onMove(); } catch {} }, debounce);
    }
    if (onAttention && FAIL_RE.test(text)) {
      clearTimeout(attentionTimer);
      attentionTimer = setTimeout(() => { try { onAttention(); } catch {} }, debounce);
    }
  }

  function setup() {
    if (closed) return;
    try {
      // Start from the current end so we only react to future moves.
      try { lastSize = fs.statSync(logPath).size; } catch { lastSize = 0; }
      watcher = fs.watch(logPath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') { reattach(); return; } // file replaced/rotated
        readNewLines();
      });
      watcher.on('error', reattach);
    } catch {
      // File missing or unwatchable — retry until it exists.
      scheduleRetry();
    }
  }

  function reattach() {
    try { watcher && watcher.close(); } catch {}
    watcher = null;
    scheduleRetry();
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; setup(); }, Math.max(50, retryMs));
  }

  function close() {
    closed = true;
    clearTimeout(debounceTimer);
    clearTimeout(attentionTimer);
    clearTimeout(retryTimer);
    retryTimer = null;
    try { watcher && watcher.close(); } catch {}
    watcher = null;
  }

  return { setup, close };
};
