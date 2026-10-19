// The Organizer page's activity feed: the organizer's log turned into things that
// happened, newest first. A season import is one entry with its episodes inside,
// a skip or review says which title and why (and how many scans have repeated
// it), startup chatter folds into one line, and heartbeats, empty scans and
// separators vanish. The organizer itself and its log are untouched; this only
// reads. Line shapes are the ones the organizer has written since June 2026
// (see organizer-activity.test.js for each).
const path = require('path');
const { isTestArtifact, parseMovedEvent } = require('./organizer-log');

const STAMP = /^\s*\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]\s?(.*)$/s;
const EPISODE = /S(\d{1,2})E(\d{1,3})/i;
const VIDEO = /\.(mp4|mkv|avi|m4v|mov|webm|ts|wmv|flv|mpe?g)$/i;
const SUBTITLE = /\.(srt|vtt|ass|ssa|sub|idx)$/i;
const KINDS = {
  imports: ['import', 'backfill'], moves: ['import', 'backfill'],
  problems: ['skip', 'review', 'problem'], errors: ['skip', 'review', 'problem'],
  organizer: ['start', 'note'], scans: ['start', 'note'],
};
const SKIP_REASONS = [
  [/^No confident OMDb match for: (.+)$/, 'No confident OMDb match'],
  [/^No OMDb match for series: (.+)$/, 'No OMDb match for the series'],
  [/^No episode number in: (.+)$/, 'No episode number in the file name'],
  [/^Destination already exists: (.+)$/, 'Already in the library'],
  [/^Destination already has the movie: (.+)$/, 'Already in the library', true],
];

const trimSlash = value => String(value || '').replace(/\/+$/, '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function parseLine(raw) {
  // A crash mid-write once left a line padded with NUL bytes; strip control characters before the stamp.
  const match = STAMP.exec(String(raw).replace(/^[\x00-\x08\x0b-\x1f]+/, ''));
  if (!match) return { at: 0, message: String(raw) };
  const at = Date.parse(`${match[1]}T${match[2]}`);
  return { at: Number.isFinite(at) ? at : 0, message: match[3] };
}

// "/mnt/media/TV/Show/Season 01/x.mkv" -> "TV/Show/Season 01/x.mkv". The download folder and the
// configured library roots are shown by their last folder name, which is how the pages name them.
// Only folders count as roots: a file path handed in by mistake would swallow its own title.
function makeRoots({ sourceDir, libraryRoots }) {
  const roots = [];
  if (sourceDir) roots.push({ root: trimSlash(sourceDir), label: path.basename(trimSlash(sourceDir)), source: true });
  for (const root of libraryRoots || []) if (root && !VIDEO.test(root) && !SUBTITLE.test(root)) roots.push({ root: trimSlash(root), label: path.basename(trimSlash(root)), source: false });
  roots.sort((a, b) => b.root.length - a.root.length);
  const find = value => roots.find(({ root }) => value.startsWith(root + '/')) || null;
  const short = value => { const hit = find(String(value || '')); return hit ? hit.label + String(value).slice(hit.root.length) : String(value || ''); };
  const relative = value => { const hit = find(String(value || '')); return hit ? { label: hit.label, parts: String(value).slice(hit.root.length + 1).split('/') } : null; };
  return { short, relative, sourceLabel: roots.find(r => r.source)?.label || 'the download folder' };
}

function episodeLabel(file) {
  const name = path.basename(file).replace(/\.[a-z0-9]{2,5}$/i, '');
  const code = EPISODE.exec(name);
  if (!code) return { label: name };
  const rest = name.slice(code.index + code[0].length).replace(/^\s*[-–·]\s*/, '').trim();
  const text = `S${code[1].padStart(2, '0')}E${code[2].padStart(2, '0')}`;
  return { label: rest ? `${text} · ${rest}` : text, code: text, season: Number(code[1]), episode: Number(code[2]) };
}

const mediaOf = file => (VIDEO.test(file) ? 'video' : SUBTITLE.test(file) ? 'subtitle' : 'other');
const reasonOf = error => String(error || '').replace(/^\[Errno \d+\]\s*/, '').replace(/:\s*'.*$/s, '').trim();

function organizerActivity(lines, options = {}) {
  const roots = makeRoots(options);
  const entries = [];
  let seq = 0;
  const push = entry => { entry.seq = seq++; entries.push(entry); return entry; };
  const last = () => entries[entries.length - 1];
  const note = (entry, text) => { if (entry && !entry.notes.includes(text)) entry.notes.push(text); };

  let current = null;      // open import group
  let lastOutcome = null;  // the skip or review this scan ended in, for the folder clean-up lines that follow
  let backfill = null;     // open title-backfill run
  let found = null;        // { release, type } from the last "[TV]/[MOVIE] Found:" line
  let matched = null;      // "OMDb match: X" since that line
  let rejected = [];       // "Rejected: ..." diagnostics since that line, for a skip
  let lookupNotes = [];    // "OMDb ... lookup failed" since that line, for a review or skip
  let planned = null;      // "Import source: A -> B" waiting for its "Moved -> B"
  let pending = null;      // an older-form move, held back in case its event follows
  let orphans = [];        // clean-up notes written before the outcome they belong to, in this scan

  const releaseOf = source => roots.relative(source)?.parts[0] || path.basename(path.dirname(source));
  // A folder clean-up line names its release; it belongs to the entry that handled that release,
  // even when that was an earlier scan (a review retried, a retained folder emptied later).
  const byRelease = name => { for (let i = entries.length - 1; i >= Math.max(0, entries.length - 25); i--) { const e = entries[i]; if (e.release === name && e.notes) return e; } return null; };
  const dropOrphans = () => { for (const orphan of orphans) push({ kind: 'note', title: orphan.text, summary: '', notes: [], count: 1, at: orphan.at }); orphans = []; };
  // (cleanup() below records the line's own time for that case.)
  const adopt = entry => { for (const orphan of orphans) note(entry, orphan.note); orphans = []; return entry; };
  const endScan = () => { dropOrphans(); current = null; lastOutcome = null; found = null; matched = null; rejected = []; lookupNotes = []; };
  // A clean-up line with nothing to belong to yet waits for the outcome this scan ends in.
  let lineAt = 0;
  const cleanup = (text, noteText) => { const target = current || lastOutcome; if (target) note(target, noteText); else orphans.push({ text, note: noteText, at: lineAt }); };

  function addMove(move, at) {
    const release = move.release || found?.release || (move.source ? releaseOf(move.source) : null) || path.basename(path.dirname(move.destination));
    const where = roots.relative(move.destination);
    let parts, label;
    if (where) { parts = where.parts; label = where.label; }
    else {
      // No configured root matched: name the title's folder and the one above it ("TV/The Sopranos (1999)").
      const file = path.basename(move.destination), folder = path.dirname(move.destination);
      const seasonFolder = /^season\b/i.test(path.basename(folder));
      const titleDir = seasonFolder ? path.dirname(folder) : folder;
      parts = seasonFolder ? [path.basename(titleDir), path.basename(folder), file] : [path.basename(titleDir), file];
      label = path.basename(path.dirname(titleDir));
    }
    const season = parts.length >= 3 && /^season\b/i.test(parts[1]);
    if (!current || current.release !== release) {
      current = adopt(push({ kind: 'import', type: found?.type || (season ? 'show' : 'movie'), release, title: parts[0] || release,
        to: `${label}/${parts[0]}`, matched, items: [], notes: [], count: 0, at, since: at }));
      lastOutcome = null;
    }
    if (season) current.type = 'show';
    const episode = episodeLabel(move.destination);
    current.items.push({ label: episode.label, from: move.source ? roots.short(move.source) : '', to: where ? roots.short(move.destination) : [label, ...parts].join('/'),
      media: mediaOf(move.destination), code: episode.code, season: episode.season, episode: episode.episode });
    current.at = Math.max(current.at, at);
  }
  const flushPending = () => { if (pending) { const move = pending; pending = null; addMove(move, move.at); } };

  // Repeats of the same outcome across scans are one entry that counts how often it was seen.
  function outcome(entry, at) {
    const previous = last();
    if (previous && previous.kind === entry.kind && previous.title === entry.title && previous.summary === entry.summary && previous.type === entry.type) {
      previous.count++; previous.at = Math.max(previous.at, at);
      for (const text of entry.notes) note(previous, text);
      lastOutcome = previous;
      return previous;
    }
    lastOutcome = adopt(push({ ...entry, count: 1, since: at, at }));
    return lastOutcome;
  }

  for (const raw of lines) {
    if (isTestArtifact(raw)) continue;
    const { at, message } = parseLine(raw);
    lineAt = at;
    const text = message.trim();
    if (!text || text.startsWith('Still watching...') || text === 'Press Ctrl+C to stop' || /^=+$/.test(text)) continue;
    const indented = /^\s/.test(message);

    // A completed move, in either form the organizer has written.
    const event = parseMovedEvent(text);
    if (event) {
      if (pending && pending.destination === event.destination) pending = null;
      flushPending();
      addMove(event, at);
      continue;
    }
    if (text.startsWith('Import source: ')) {
      flushPending();
      const parts = text.slice(15).split(' -> ');
      planned = parts.length === 2 ? { source: parts[0], destination: parts[1] } : null;
      continue;
    }
    if (text.startsWith('Moved -> ')) {
      flushPending();
      const destination = text.slice(9);
      pending = { source: planned && planned.destination === destination ? planned.source : null, destination, release: null, at };
      planned = null;
      continue;
    }
    flushPending();

    if (text.startsWith('[BACKFILL] ')) {
      const body = text.slice(11);
      if (!backfill) backfill = push({ kind: 'backfill', title: 'Episode titles added to file names', items: [], notes: [], count: 0, at });
      backfill.at = Math.max(backfill.at, at);
      const renamed = /^Renamed: (.+?) -> (.+)$/.exec(body);
      if (renamed) { backfill.items.push({ label: renamed[2], from: path.basename(renamed[1]), to: roots.short(path.dirname(renamed[1])) }); backfill.count++; }
      else if (/^Still without a title/.test(body)) note(backfill, body);
      continue;
    }
    backfill = null;

    let match;
    if ((match = /^Watching (.+?) \(polling every (\d+)s\)$/.exec(text))) {
      endScan();
      const previous = last();
      if (previous && previous.kind === 'start') { previous.count++; previous.at = Math.max(previous.at, at); }
      else push({ kind: 'start', title: 'Organizer started', summary: `Checking ${path.basename(trimSlash(match[1]))} every ${match[2]} s`, notes: [], count: 1, at });
    } else if ((match = /^\[(TV|MOVIE)\] Found: (.+)$/.exec(text))) {
      if (current && current.release !== match[2]) current = null;
      lastOutcome = null; found = { release: match[2], type: match[1] === 'TV' ? 'show' : 'movie' };
      matched = null; rejected = []; lookupNotes = [];
    } else if (/^Scan complete\./.test(text)) {
      endScan();
    } else if (text.startsWith('SKIP: ')) {
      const reason = text.slice(6);
      let title = found?.release || reason, summary = reason;
      const known = SKIP_REASONS.map(([pattern, label, base]) => [pattern.exec(reason), label, base]).find(([hit]) => hit);
      if (known) { title = known[2] ? path.basename(trimSlash(known[0][1])) : known[0][1]; summary = known[1]; }
      else if ((match = /^([^:]{3,60}): (.+)$/.exec(reason))) { summary = match[1]; title = match[2]; }
      outcome({ kind: 'skip', type: found?.type || null, title, summary, release: found?.release || null, notes: [...rejected.slice(-3), ...lookupNotes] }, at);
      rejected = []; lookupNotes = [];
    } else if (text.startsWith('REVIEW: {')) {
      let review = null;
      try { review = JSON.parse(text.slice(8)); } catch { review = null; }
      if (!review || typeof review.title !== 'string') { push({ kind: 'problem', title: text, summary: '', notes: [], count: 1, at }); continue; }
      const type = review.type === 'series' || review.type === 'show' ? 'show' : 'movie', reason = String(review.reason || 'Needs review');
      const previous = last();
      if (previous && previous.kind === 'review' && previous.title === review.title && previous.type === type) {
        // The same title again: another reason for the same report, or the next scan repeating it.
        if (reason === previous.summary) previous.count++; else note(previous, reason);
        previous.at = Math.max(previous.at, at); lastOutcome = previous;
      } else {
        lastOutcome = adopt(push({ kind: 'review', type, title: review.title, summary: reason, release: review.source || found?.release || null, notes: [], lookup: lookupNotes.splice(0), count: 1, since: at, at }));
      }
    } else if (/lookup failed/i.test(text) && !indented) {
      lookupNotes.push(text);
    } else if ((match = /^Could not delete folder (.+?): (.+)$/s.exec(text))) {
      const summary = `Could not delete the source folder: ${reasonOf(match[2])}`;
      const target = current || lastOutcome;
      if (target) note(target, summary);
      else push({ kind: 'problem', title: path.basename(trimSlash(match[1])), summary, notes: [], count: 1, at });
    } else if ((match = /^Deleting source folder with (\d+) extra file\(s\)/.exec(text))) {
      cleanup(text, `Source folder deleted (${plural(Number(match[1]), 'extra file')} removed)`);
    } else if ((match = /^(?:Deleted source folder|Removed empty source folder): (.+)$/.exec(text))) {
      const target = current || lastOutcome || byRelease(match[1]);
      if (target) { if (!target.notes.some(n => n.startsWith('Source folder deleted'))) note(target, 'Source folder deleted'); }
      else orphans.push({ text, note: 'Source folder deleted', at });
    } else if ((match = /^Retained source folder with remaining files: (.+)$/.exec(text))) {
      const target = current || lastOutcome || byRelease(match[1]);
      if (target) note(target, `Leftover files kept in ${roots.sourceLabel}`); else orphans.push({ text, note: `Leftover files kept in ${roots.sourceLabel}`, at });
    } else if ((match = /^(Removed empty destination folder|Cleared stale movie-less destination folder): (.+)$/.exec(text))) {
      push({ kind: 'note', title: 'Removed an empty folder', summary: roots.short(match[2]), notes: [], count: 1, at });
    } else if (indented) {
      // Matching diagnostics: kept only as context for the outcome that follows.
      if (/^Rejected/.test(text)) { rejected.push(text); if (rejected.length > 6) rejected.shift(); }
      else if ((match = /^OMDb match: (.+)$/.exec(text))) matched = match[1];
    } else if (/ERROR|Traceback|FAIL/i.test(text)) {
      push({ kind: 'problem', title: text, summary: '', notes: [], count: 1, at });
    } else {
      push({ kind: 'note', title: text, summary: '', notes: [], count: 1, at });
    }
  }
  flushPending();
  dropOrphans();

  for (const entry of entries) {
    if (entry.kind === 'import') {
      const videos = entry.items.filter(item => item.media === 'video'), subtitles = entry.items.filter(item => item.media === 'subtitle');
      const counted = videos.length ? videos : entry.items;
      entry.count = counted.length;
      if (entry.type === 'show') {
        const coded = counted.filter(item => item.code).sort((a, b) => a.season - b.season || a.episode - b.episode);
        entry.summary = entry.count === 1 ? counted[0].label
          : coded.length ? `${plural(entry.count, 'episode')} · ${coded[0].code}–${coded[coded.length - 1].code}` : plural(entry.count, 'episode');
      } else {
        entry.summary = videos.length === 1 ? path.basename(videos[0].to) : videos.length > 1 ? plural(videos.length, 'video file') : plural(entry.count, 'file');
      }
      if (subtitles.length) entry.notes.unshift(plural(subtitles.length, 'subtitle file'));
      // Videos first, then the rest; the bookkeeping only served the lines above.
      entry.items = [...counted, ...entry.items.filter(item => !counted.includes(item))].map(({ label, from, to }) => ({ label, from, to }));
    } else if (entry.kind === 'backfill') {
      entry.summary = `${plural(entry.count, 'file')} renamed`;
    } else if (entry.kind === 'review') {
      entry.notes = [...entry.notes, ...(entry.lookup || [])];
      delete entry.lookup;
    }
    entry.id = `${entry.kind}-${entry.at}-${entry.seq}`;
    delete entry.seq;
  }
  return entries.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

function filterActivity(entries, filter = 'all', q = '') {
  const kinds = KINDS[filter];
  const needle = String(q || '').trim().toLowerCase();
  return entries.filter(entry => {
    if (kinds && !kinds.includes(entry.kind)) return false;
    if (!needle) return true;
    const haystack = [entry.title, entry.summary, entry.release, entry.to, entry.matched, ...(entry.notes || []),
      ...(entry.items || []).map(item => `${item.label} ${item.from} ${item.to}`)].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes(needle);
  });
}

module.exports = { organizerActivity, filterActivity };
