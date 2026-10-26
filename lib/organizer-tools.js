const crypto = require('crypto');
const { isTestArtifact, parseMovedEvent } = require('./organizer-log');

function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function aliasId(from, type = 'all') {
  return crypto.createHash('sha1').update(`${type}:${norm(from).toLowerCase()}`).digest('hex').slice(0, 12);
}

function loadAliases(loadJSON, file) {
  const raw = loadJSON(file, { aliases: [] });
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.aliases) ? raw.aliases : []);
  return list
    .map(a => ({
      id: a.id || aliasId(a.from, a.type),
      from: norm(a.from),
      to: norm(a.to),
      type: ['movie', 'series', 'all'].includes(a.type) ? a.type : 'all',
      ...(/^\d{4}$/.test(String(a.year || '')) ? { year: String(a.year) } : {}),
      createdAt: a.createdAt || Date.now(),
      updatedAt: a.updatedAt || a.createdAt || Date.now(),
    }))
    .filter(a => a.from && a.to);
}

function saveAliases(saveJSON, file, aliases) {
  saveJSON(file, { aliases });
  return aliases;
}

// An IMDb number typed or pasted as a link ("imdb.com/title/tt10794054/?ref=..."), else null.
function imdbId(value) {
  const m = String(value || '').trim().match(/^(?:(?:https?:\/\/)?(?:www\.|m\.)?imdb\.com\/title\/)?(tt\d{7,10})\b/i);
  return m ? m[1].toLowerCase() : null;
}

function upsertAlias(aliases, input) {
  const from = norm(input.from);
  const pinned = imdbId(input.to);
  const to = pinned || norm(input.to);
  const type = ['movie', 'series', 'all'].includes(input.type) ? input.type : 'all';
  if (!from || !to) return null;
  // An IMDb number names one film, so it applies only to the release year it was chosen for
  // (the organizer still searches another film of the same name). Title aliases have no year.
  const year = pinned && /^\d{4}$/.test(String(input.year || '')) ? String(input.year) : undefined;
  const id = input.id || aliasId(year ? `${from} ${year}` : from, type);
  const now = Date.now();
  const existing = aliases.findIndex(a => a.id === id
    || (a.type === type && a.from.toLowerCase() === from.toLowerCase() && (a.year || undefined) === year));
  const next = {
    id,
    from,
    to,
    type,
    ...(year ? { year } : {}),
    createdAt: existing >= 0 ? aliases[existing].createdAt : now,
    updatedAt: now,
  };
  if (existing >= 0) aliases[existing] = next;
  else aliases.unshift(next);
  return next;
}

function parseTimestamp(line) {
  const m = line.match(/^\[?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]?\s*(.*)$/);
  if (!m) return { timestamp: null, message: line };
  const parsed = Date.parse(m[1].replace(' ', 'T'));
  return { timestamp: Number.isNaN(parsed) ? null : parsed, message: m[2] };
}

// The file a review note is about. New notes carry it as `file`; older ones name it in their reason.
const REVIEW_FILE_PATTERNS = [
  /^Could not import (.+?): /i,
  /:\s+([^:;]+?)(?:\s+->\s+[^;]*)?;\s*source retained\s*$/i,
];
function reviewFile(entry) {
  if (typeof entry.file === 'string' && entry.file.trim()) return entry.file;
  const reason = String(entry.reason || '');
  for (const pattern of REVIEW_FILE_PATTERNS) {
    const match = reason.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function parseOrganizerFixQueue(lines, aliases = []) {
  const entries = new Map();
  const lookupsBySource = new Map();
  const reviewsBySource = new Map();   // release name -> its manual-review entries
  const now = Date.now();
  let current = null;
  let order = 0;

  // A release name is a filesystem identity, not a normalized title. Keep its
  // case and internal whitespace so one release cannot resolve another's issue.
  const sourceName = value => String(value || '').trim();
  const releaseKey = (type, source) => source ? JSON.stringify([type, source]) : null;
  const isLater = (event, previous) => {
    if (event.timestamp !== null && previous.timestamp !== null && event.timestamp !== previous.timestamp) {
      return event.timestamp > previous.timestamp;
    }
    return event.order > previous.order;
  };

  function resolveLookup(type, source, timestamp, resolution) {
    const key = releaseKey(type, sourceName(source));
    if (!key) return;
    const event = { timestamp, order };
    for (const state of lookupsBySource.get(key) || []) {
      if (!isLater(event, state.event)) continue;
      if (state.item.resolved) {
        state.event = event;
        continue;
      }
      state.item.resolved = true;
      state.item.status = 'resolved';
      state.item.resolvedAt = timestamp ?? now;
      state.item.resolution = resolution;
      state.event = event;
    }
  }

  // A file that was imported after a note was written about it no longer needs a person.
  function resolveReviewsForMove(move, timestamp) {
    if (!move.release) return;
    const file = String(move.source).split(/[\\/]/).pop();
    const event = { timestamp, order };
    for (const state of reviewsBySource.get(sourceName(move.release)) || []) {
      const item = state.item;
      if (item.resolved || item.file !== file || !isLater(event, state.event)) continue;
      Object.assign(item, { resolved: true, status: 'resolved', resolvedAt: timestamp ?? now, resolution: 'Imported after review' });
      state.event = event;
    }
  }

  function addEntry(partial) {
    const title = norm(partial.title);
    if (!title) return;
    const type = partial.type || current?.type || 'unknown';
    const context = current?.type === type ? current : null;
    const source = sourceName(partial.source ?? context?.source);
    const year = partial.year ?? (source && source === context?.source ? context.year : null) ?? null;
    const manualReview = !!partial.manualReview;
    const reason = String(partial.reason || 'No OMDb match').trim();
    const file = manualReview ? reviewFile({ ...partial, reason }) : null;
    const sourceKey = releaseKey(type, source);
    // Lookup failures share one lifecycle per exact release. File/episode
    // reviews share only an identical reason, so separate episodes stay visible.
    const key = JSON.stringify([type, manualReview ? 'review' : 'lookup',
      source || [title.toLowerCase(), year], ...(manualReview ? [reason] : [])]);
    const existing = entries.get(key);
    const event = { timestamp: partial.timestamp, order };
    const seenAt = partial.timestamp ?? now;
    const matchedAlias = aliases.find(a =>
      (a.type === 'all' || (type === 'show' && a.type === 'series') || a.type === type) &&
      a.from.toLowerCase() === title.toLowerCase()
    );
    const item = existing?.item || {
      id: crypto.createHash('sha1').update(key).digest('hex').slice(0, 12),
      manualReview,
      type,
      title,
      year,
      source,
      reason,
      count: 0,
      firstSeen: seenAt,
      lastSeen: seenAt,
      suggestedAlias: matchedAlias?.to || '',
      resolved: false,
      status: 'open',
      file,
    };
    item.count += 1;
    item.firstSeen = Math.min(item.firstSeen, seenAt);
    item.lastSeen = Math.max(item.lastSeen, seenAt);
    if (!existing || isLater(event, existing.event)) {
      Object.assign(item, { title, year, source, reason, file, resolved: false, status: 'open', suggestedAlias: matchedAlias?.to || '' });
      delete item.resolvedAt;
      delete item.resolution;
      const state = existing || { item };
      state.event = event;
      entries.set(key, state);
      if (!existing && !manualReview && sourceKey) {
        if (!lookupsBySource.has(sourceKey)) lookupsBySource.set(sourceKey, []);
        lookupsBySource.get(sourceKey).push(state);
      }
      if (!existing && manualReview && source) {
        if (!reviewsBySource.has(source)) reviewsBySource.set(source, []);
        reviewsBySource.get(source).push(state);
      }
    }
  }

  for (const raw of lines) {
    order += 1;
    const parsed = parseTimestamp(raw);
    const { timestamp } = parsed;
    const message = parsed.message.trimStart();
    // Lines a unit-test run left in the live log must not become review entries.
    if (isTestArtifact(message)) continue;
    if (message.startsWith('REVIEW: ')) {
      try {
        const entry = JSON.parse(message.slice(8));
        if (['show', 'movie'].includes(entry.type) && sourceName(entry.source) && entry.title && entry.reason) {
          resolveLookup(entry.type, entry.source, timestamp, 'Title matched; source needs manual review');
          addEntry({ ...entry, timestamp, manualReview: true });
        }
      } catch { /* An incomplete log line is retried on the next refresh. */ }
      continue;
    }
    const moved = parseMovedEvent(message);
    if (moved) {
      resolveReviewsForMove(moved, timestamp);
      continue;
    }
    let m = message.match(/^\[(TV|MOVIE)\]\s+Found:\s+(.+)$/i);
    if (m) {
      current = { type: m[1].toLowerCase() === 'tv' ? 'show' : 'movie', source: sourceName(m[2]), timestamp };
      continue;
    }
    // Library rescans do not emit Found lines. Their next result must not be
    // mistaken for a retry of the last incoming release in the same log.
    if (/^\[\d+\/\d+\]\s+Checking:|^Scanning\s|^.*library scan complete\./i.test(message)) {
      current = null;
      continue;
    }
    m = message.match(/^Parsed:\s+title='(.*)'(?:,\s+year=([0-9]{4}|none)|,\s+S\d|$)/i);
    if (m) {
      current = { ...(current || {}), title: norm(m[1]), year: m[2] && m[2] !== 'none' ? m[2] : null, timestamp };
      continue;
    }
    m = message.match(/^OMDb match:\s+(.+)$/i);
    if (m && current?.source && current?.type) {
      resolveLookup(current.type, current.source, timestamp, `OMDb match: ${norm(m[1])}`);
      continue;
    }
    m = message.match(/^SKIP:\s+No OMDb match for series:\s+(.+)$/i);
    if (m) {
      addEntry({ type: 'show', title: norm(m[1]), timestamp, reason: 'No OMDb match for series' });
      continue;
    }
    // Genuinely different from a plain "unknown title" — OMDb has this exact
    // title, just filed under type=series instead of movie (Band of Brothers
    // is the case that surfaced this: query_omdb's &type=movie filter hides
    // the real series entry and matches an unrelated movie-typed record
    // instead, e.g. a "making of" documentary, which is then correctly
    // rejected). A single-file release with no season/episode markers can't
    // be auto-placed as TV, so this still lands in the fix-queue, but with a
    // reason that says what is actually true instead of implying OMDb has
    // never heard of the title.
    m = message.match(/^\s*SKIP:\s+'(.+?)'\s+is a TV series in OMDb\s+\(([^,]+),\s*(\d{4})\)/i);
    if (m) {
      addEntry({
        type: 'movie', title: norm(m[1]), timestamp,
        reason: `Actually a TV series in OMDb (${norm(m[2])}, ${m[3]}) — needs season/episode markers, not a movie rename`,
      });
      continue;
    }
    m = message.match(/^SKIP:\s+No confident OMDb match for:\s+(.+?)\s+\(([^)]*)\)$/i);
    if (m) {
      const year = m[2] && m[2] !== 'no year' ? m[2] : null;
      addEntry({ type: 'movie', title: norm(m[1]), year, timestamp, reason: 'No confident OMDb match' });
      continue;
    }
    if (/^SKIP:\s+No confident OMDb match$/i.test(message) && current?.title) {
      addEntry({ ...current, reason: 'No confident OMDb match', timestamp });
    }
  }

  return [...entries.values()].map(state => state.item).sort((a, b) => b.lastSeen - a.lastSeen);
}

module.exports = {
  aliasId,
  loadAliases,
  saveAliases,
  upsertAlias,
  parseOrganizerFixQueue,
};
