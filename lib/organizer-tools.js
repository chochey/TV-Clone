const crypto = require('crypto');

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
      createdAt: a.createdAt || Date.now(),
      updatedAt: a.updatedAt || a.createdAt || Date.now(),
    }))
    .filter(a => a.from && a.to);
}

function saveAliases(saveJSON, file, aliases) {
  saveJSON(file, { aliases });
  return aliases;
}

function upsertAlias(aliases, input) {
  const from = norm(input.from);
  const to = norm(input.to);
  const type = ['movie', 'series', 'all'].includes(input.type) ? input.type : 'all';
  if (!from || !to) return null;
  const id = input.id || aliasId(from, type);
  const now = Date.now();
  const existing = aliases.findIndex(a => a.id === id || (a.type === type && a.from.toLowerCase() === from.toLowerCase()));
  const next = {
    id,
    from,
    to,
    type,
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

function parseOrganizerFixQueue(lines, aliases = []) {
  const entries = new Map();
  let current = null;

  function addEntry(partial) {
    const title = norm(partial.title);
    if (!title) return;
    const type = partial.type || current?.type || 'unknown';
    const year = partial.year || null;
    const key = `${type}:${title.toLowerCase()}:${year || ''}`;
    const existing = entries.get(key);
    const matchedAlias = aliases.find(a =>
      (a.type === 'all' || (type === 'show' && a.type === 'series') || a.type === type) &&
      a.from.toLowerCase() === title.toLowerCase()
    );
    const item = existing || {
      id: aliasId(title, type),
      type,
      title,
      year,
      source: partial.source || current?.source || '',
      reason: partial.reason || 'No OMDb match',
      count: 0,
      firstSeen: partial.timestamp || Date.now(),
      lastSeen: partial.timestamp || Date.now(),
      suggestedAlias: matchedAlias?.to || '',
    };
    item.count += 1;
    item.lastSeen = Math.max(item.lastSeen || 0, partial.timestamp || Date.now());
    item.source = partial.source || current?.source || item.source;
    item.reason = partial.reason || item.reason;
    if (matchedAlias) item.suggestedAlias = matchedAlias.to;
    entries.set(key, item);
  }

  for (const raw of lines) {
    const { timestamp, message } = parseTimestamp(raw);
    let m = message.match(/^\[(TV|MOVIE)\]\s+Found:\s+(.+)$/i);
    if (m) {
      current = { type: m[1].toLowerCase() === 'tv' ? 'show' : 'movie', source: norm(m[2]), timestamp };
      continue;
    }
    m = message.match(/^Parsed:\s+title='([^']+)'(?:,\s+year=([0-9]{4}|none))?/i);
    if (m) {
      current = { ...(current || {}), title: norm(m[1]), year: m[2] && m[2] !== 'none' ? m[2] : null, timestamp };
      continue;
    }
    m = message.match(/^SKIP:\s+No OMDb match for series:\s+(.+)$/i);
    if (m) {
      addEntry({ type: 'show', title: norm(m[1]), timestamp, reason: 'No OMDb match for series' });
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

  return [...entries.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

module.exports = {
  aliasId,
  loadAliases,
  saveAliases,
  upsertAlias,
  parseOrganizerFixQueue,
};
