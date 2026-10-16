// Watch the media-organizer log and trigger a library rescan when it files a
// new title. The media folders are on fuse.mergerfs, where fs.watch/inotify
// does NOT see writes — so watching the folders is useless. The organizer log
// is on local ext4 and gets a "Moved -> " line per filed file, so we watch it
// instead. Debounced so a burst of episodes coalesces into one rescan.
const fs = require('fs');
const { TEMP_ARTIFACT } = require('./organizer-log');

const MOVE_RE = /Moved -> |Deleted source folder/;
// Placement failures the organizer logged in its older plain-text form: it gives
// up on a title and it stays stuck in the Share folder.
const FAIL_RE = /SKIP: No (confident )?OMDb match|SKIP: No files with episode numbers found|SKIP: Could not parse title/;
// Everything else that needs a person -- duplicate movies, name conflicts, an
// ambiguous season/episode, an unverifiable library -- is logged as one JSON
// line: "REVIEW: {type,title,source,reason}". That used to match none of the
// patterns above, so in practice nobody was ever told about it.
const REVIEW_MARKER = 'REVIEW: {';
const REPEAT_QUIET_MS = 12 * 60 * 60 * 1000;   // one notification per release+reason per 12 h
const MAX_REMEMBERED = 500;

function parseReviewLine(line) {
  const at = line.indexOf(REVIEW_MARKER);
  if (at < 0) return null;
  try {
    const entry = JSON.parse(line.slice(at + 8));
    if (!entry || typeof entry !== 'object' || !entry.source || !entry.reason) return null;
    return { type: String(entry.type || ''), title: String(entry.title || ''), source: String(entry.source), reason: String(entry.reason) };
  } catch { return null; }   // a half-written line is simply not an event yet
}

// Plain-language versions of the reasons the organizer gives, for a notification.
function friendlyReason(reason) {
  const r = String(reason || '').replace(/;\s*source retained\s*$/i, '').trim();
  if (/^Movie already exists/i.test(r)) return 'Already in your library. The new copy was kept so you can compare.';
  if (/^Destination conflict/i.test(r)) return 'A file with that name already exists, so nothing was overwritten.';
  if (/^Missing or ambiguous season\/episode/i.test(r)) return `Could not tell the season or episode (${r.split(':').slice(1).join(':').trim() || 'see the Organizer page'}).`;
  if (/^Cannot verify existing movie folders/i.test(r)) return 'Could not check the library for an existing copy, so it was left alone.';
  if (/^File belongs to a different or uncertain series/i.test(r)) return 'The file does not clearly belong to this series.';
  if (/^Multiple videos need individual identification/i.test(r)) return 'Several videos in one download need to be identified one by one.';
  return r.length > 140 ? `${r.slice(0, 137)}...` : r;
}

// What to tell admins for a batch of new review events. Pure, so it is testable.
function describeAttention(batch = {}) {
  const reviews = Array.isArray(batch.reviews) ? batch.reviews : [];
  const total = reviews.length + (batch.legacy || 0);
  const title = 'Organizer needs attention';
  if (!reviews.length) return { title, body: 'A download could not be matched to a title' };
  const first = reviews[0];
  const name = first.title || first.source;
  if (total === 1) return { title, body: `${name}: ${friendlyReason(first.reason)}` };
  const releases = new Set(reviews.map(r => r.source)).size + (batch.legacy || 0);
  return { title, body: `${releases} download${releases === 1 ? '' : 's'} need review. First: ${name}: ${friendlyReason(first.reason)}` };
}

module.exports = function createOrganizerWatch({ logPath, onMove, onAttention, debounceMs = 15000, retryMs = 30000 }) {
  // Floor low enough for fast tests but high enough to prevent a busy-loop.
  const debounce = Math.max(50, parseInt(debounceMs, 10) || 15000);
  let watcher = null;
  let retryTimer = null;
  let debounceTimer = null;
  let attentionTimer = null;
  let lastSize = 0;
  let closed = false;
  let pending = { reviews: [], legacy: 0 };
  let carry = '';             // an unfinished last line, completed by the next append
  const recent = new Map();   // review key -> time notified

  function readNewLines() {
    let st;
    try { st = fs.statSync(logPath); } catch { return; }
    // Truncated/rotated: start over from the top.
    if (st.size < lastSize) { lastSize = 0; carry = ''; }
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
    // A line can arrive in two appends; only act on complete lines.
    text = carry + text;
    const cut = text.lastIndexOf('\n');
    if (cut < 0) { carry = text; return; }
    carry = text.slice(cut + 1);
    text = text.slice(0, cut + 1);
    const lines = text.split('\n').filter(line => !TEMP_ARTIFACT.test(line));
    if (MOVE_RE.test(lines.join('\n'))) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { try { onMove(); } catch {} }, debounce);
    }
    if (!onAttention) return;
    const now = Date.now();
    for (const [key, at] of recent) if (now - at > REPEAT_QUIET_MS) recent.delete(key);
    let fresh = false;
    for (const line of lines) {
      const review = parseReviewLine(line);
      if (review) {
        const key = JSON.stringify([review.type, review.source, review.reason]);
        if (recent.has(key)) continue;            // already told someone about this exact case
        if (recent.size >= MAX_REMEMBERED) recent.delete(recent.keys().next().value);
        recent.set(key, now);
        pending.reviews.push(review);
        fresh = true;
      } else if (FAIL_RE.test(line)) {
        pending.legacy += 1;
        fresh = true;
      }
    }
    if (fresh) {
      clearTimeout(attentionTimer);
      attentionTimer = setTimeout(() => {
        const batch = pending;
        pending = { reviews: [], legacy: 0 };
        try { onAttention(batch); } catch {}
      }, debounce);
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

module.exports.describeAttention = describeAttention;
module.exports.friendlyReason = friendlyReason;
module.exports.parseReviewLine = parseReviewLine;
module.exports.TEMP_ARTIFACT = TEMP_ARTIFACT;
