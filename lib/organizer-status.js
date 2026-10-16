'use strict';
// The organizer keeps a small JSON file current (media-organizer/organizer_status.py). The Organizer
// page reads it instead of inferring "is it alive?" from a heartbeat line in the log, which goes
// missing while a long copy is running. The file is written by another process, so it is checked
// and reduced to a fixed shape here; anything doubtful counts as "no status" and the caller falls
// back to the log.
const fs = require('fs');

const VERSION = 1;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const whole = value => (value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.trunc(Number(value)) : null);
const count = value => whole(value) ?? 0;
const text = (value, max = 200) => (typeof value === 'string' && value ? value.slice(0, max) : null);
const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

function readStatus(file, { now = Date.now, read = fs.readFileSync } = {}) {
  let doc;
  try { doc = JSON.parse(read(file, 'utf8')); } catch { return null; }
  if (!plain(doc) || doc.version !== VERSION) return null;
  const updatedAt = whole(doc.updatedAt);
  if (!updatedAt || updatedAt <= 0 || updatedAt > now() + MAX_CLOCK_SKEW_MS) return null;

  const activity = plain(doc.activity);
  const scan = plain(doc.lastScan);
  const imported = plain(doc.lastImport);
  const omdb = plain(doc.omdb);
  return {
    updatedAt,
    startedAt: whole(doc.startedAt),
    pid: whole(doc.pid),
    scans: count(doc.scans),
    activity: { state: text(activity?.state, 20) || 'idle', detail: text(activity?.detail) || '', since: whole(activity?.since) },
    lastScan: scan ? { at: whole(scan.at), ms: whole(scan.ms), imported: count(scan.imported) } : null,
    lastImport: imported ? { at: whole(imported.at), release: text(imported.release), name: text(imported.name) } : null,
    omdb: omdb ? {
      failing: !!omdb.failing, since: whole(omdb.since), reason: text(omdb.reason),
      retryInSeconds: count(omdb.retryInSeconds), waiting: count(omdb.waiting), requestsToday: count(omdb.requestsToday),
    } : null,
  };
}

module.exports = { readStatus, VERSION };
