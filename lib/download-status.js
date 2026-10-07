const path = require('path');
const fs = require('fs');
const { parseOrganizerFixQueue } = require('./organizer-tools');
const { VIDEO_EXT } = require('./video-torrent');

const COMPLETE_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP']);
const OTHER_EXT = new Set(['.txt', '.nfo', '.url', '.jpg', '.jpeg', '.png', '.webp']);

// Build once per list response; only explicit source/destination records count.
function downloadEvidence(lines, library) {
  const known = new Set(library.map(item => item._filePath).filter(Boolean));
  const imports = [], reviews = [], datedLines = [];
  let planned = null;
  for (const line of lines) {
    const stamp = line.match(/^\[([^\]]+)\]/)?.[1];
    const at = Date.parse(stamp?.replace(' ', 'T')) / 1000;
    if (Number.isFinite(at)) datedLines.push(line);
    const move = line.match(/\] Moved -> (.+)$/);
    if (move) {
      // A historical move to this destination cannot complete a newer failed
      // attempt. Pair each completion with the preceding source record.
      if (planned?.destination === move[1] && Number.isFinite(at) && at >= planned.at) {
        planned.movedAt = at;
      }
      planned = null;
    }
    const imported = line.match(/\] Import source: (.+) -> (.+)$/);
    if (imported) {
      planned = { source: imported[1], destination: imported[2], at, movedAt: null };
      imports.push(planned);
    }
    const review = line.match(/\] REVIEW: (.+)$/);
    if (review) { try { reviews.push({ ...JSON.parse(review[1]), at }); } catch {} }
  }
  // The shared parser resolves earlier lookup failures after successful retries.
  // Untimestamped history cannot prove a failure belongs to this download.
  const failures = parseOrganizerFixQueue(datedLines)
    .filter(item => item.source && !item.manualReview && !item.resolved)
    .map(item => ({ ...item, at: item.lastSeen / 1000 }));
  return { known, imports, reviews, failures };
}

function torrentIdentity(torrent) {
  return {
    names: new Set([torrent.name, path.basename(torrent.content_path || '')].filter(Boolean)),
    since: Number(torrent.added_on || torrent.completion_on),
  };
}

function statusFromEvidence({ known, imports, reviews, failures }, torrent) {
  if (torrent.state === 'moving') return {label:'Waiting for file move', detail:'The downloader is moving completed files. The organizer will wait until that finishes.'};
  if (torrent.progress < 1) return null;
  const { names, since } = torrentIdentity(torrent);
  // Without a timestamp, old import history cannot prove this download's status.
  const recent = record => since && record.at >= since;
  const review = reviews.filter(r => recent(r) && names.has(r.source)).at(-1);
  if (review) return { label: 'Needs review', detail: review.reason };
  const matches = imports.filter(r => recent(r) && r.source.split(/[\\/]/).some(p => names.has(p))
    && r.movedAt !== null && r.movedAt >= since);
  const latestImportAt = Math.max(-Infinity, ...matches.map(r => r.at));
  const failure = failures.find(r => recent(r) && names.has(r.source) && r.at > latestImportAt);
  if (failure) return { label: 'Needs review', detail: failure.reason };
  if (matches.some(r => known.has(r.destination))) {
    return { label: 'Imported files available', detail: 'Imported media is indexed in the library. Any remaining files stay in Share.' };
  }
  if (matches.length) return { label: 'Imported — library scan pending', detail: 'The organizer moved files; the library has not indexed them yet.' };
  return { label: 'Downloaded — import not confirmed', detail: 'Check Organizer for progress or files needing review.' };
}

function canHideDownload(torrent, status) {
  return torrent.progress >= 1 && COMPLETE_STATES.has(torrent.state)
    && !torrent.reviewReason && status && status.label !== 'Needs review';
}

function createDownloadStatus(lines, library) {
  const evidence = downloadEvidence(lines, library);
  return torrent => {
    const status = statusFromEvidence(evidence, torrent);
    return status ? { ...status, readyToHide: false } : null;
  };
}

// This deliberately permits only small, recognized companion files. Unknown
// files, subtitles, media, links, and incomplete/unreadable walks keep the row.
async function sourceIsClear(sourceDir, release, io, expired) {
  const root = await io.lstat(sourceDir);
  if (!root.isDirectory() || root.isSymbolicLink()) return false;
  const rootNames = await io.readdir(sourceDir); // Missing release alone is not proof of an available drive.
  if (expired()) return false;
  const pending = [{ file: path.join(sourceDir, release), depth: 0 }];
  let visited = 0, bytes = 0;
  while (pending.length) {
    const { file, depth } = pending.pop();
    if (expired() || ++visited > 256 || depth > 5) return false;
    let stat;
    try { stat = await io.lstat(file); }
    catch (error) {
      return error.code === 'ENOENT' && depth === 0 && !rootNames.includes(release);
    }
    if (stat.isSymbolicLink()) return false;
    if (stat.isDirectory()) {
      const names = await io.readdir(file);
      if (names.length + pending.length + visited > 256) return false;
      for (const name of names) pending.push({ file: path.join(file, name), depth: depth + 1 });
    } else if (stat.isFile()) {
      if (!OTHER_EXT.has(path.extname(file).toLowerCase()) || stat.size > 1024 * 1024) return false;
      bytes += stat.size;
      if (bytes > 8 * 1024 * 1024) return false;
    } else return false;
  }
  return !expired();
}

function createDownloadStatusWithVisibility(lines, library, {
  sourceDir, io = fs.promises, libraryDegraded = false, timeoutMs = 2000,
} = {}) {
  const evidence = downloadEvidence(lines, library);
  const checks = new Map();
  const current = torrent => {
    const status = statusFromEvidence(evidence, torrent);
    return status ? { ...status, readyToHide: false } : null;
  };
  async function prove(torrent) {
    if (!sourceDir || libraryDegraded) return false;
    const root = path.resolve(sourceDir), { names, since } = torrentIdentity(torrent);
    if (!Number.isFinite(since) || since <= 0) return false;
    const attempts = new Map();
    const releases = new Set();
    for (const record of evidence.imports) {
      if (!Number.isFinite(record.at) || record.at < since || !path.isAbsolute(record.source)) continue;
      const relative = path.relative(root, record.source);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const release = relative.split(path.sep)[0];
      if (!names.has(release)) continue;
      if (!VIDEO_EXT.has(path.extname(record.source).toLowerCase())) continue;
      releases.add(release);
      // A retry replaces only the attempt for this exact source file. Distinct
      // episodes remain independent, and a later failed retry keeps its row.
      const previous = attempts.get(record.source);
      if (!previous || record.at >= previous.at) attempts.set(record.source, record);
    }
    const candidates = [...attempts.values()];
    if (releases.size !== 1 || !candidates.length || candidates.length > 1024) return false;
    if (candidates.some(r => r.movedAt === null || r.movedAt < since || !evidence.known.has(r.destination))) return false;
    const release = [...releases][0];
    // Share the complete proof, including disk checks, across client refreshes
    // during this status snapshot. Never cache just a successful first episode.
    const key = JSON.stringify([release, since]);
    if (checks.has(key)) return checks.get(key);
    if (checks.size >= 256) return false;
    const check = (async () => {
      const deadline = Date.now() + timeoutMs;
      const expired = () => Date.now() >= deadline;
      let timer;
      const work = (async () => {
        for (const target of new Set(candidates.map(r => r.destination))) {
          if (expired()) return false;
          const stat = await io.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return false;
        }
        return sourceIsClear(root, release, io, expired);
      })().catch(() => false);
      try {
        return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      } finally { clearTimeout(timer); }
    })();
    checks.set(key, check);
    return check;
  }
  const statusFor = async torrent => {
    const status = current(torrent);
    if (!canHideDownload(torrent, status)) return status;
    return { ...status, readyToHide: await prove(torrent) };
  };
  statusFor.current = current;
  statusFor.invalidate = torrent => {
    const { names, since } = torrentIdentity(torrent);
    for (const release of names) checks.delete(JSON.stringify([release, since]));
  };
  return statusFor;
}

module.exports = { createDownloadStatus, createDownloadStatusWithVisibility, canHideDownload };
