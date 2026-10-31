// Who is on ChocheyTV right now and what the server is busy with: the header's
// "Who's on" counter and panel (permission canActivity), and the restart guard
// that will not cut someone off without being told to (force).
//
// On the site = a browser holding the live-updates stream (/api/events) open,
// or playing something. Playing = a progress ping within the last minute, the
// same window as /api/now-watching. The busy list is cached briefly because it
// asks systemctl, /proc and qBittorrent; the people are always fresh.
const fs = require('fs');
const path = require('path');

const PLAYING_WINDOW_MS = 60_000;

function people({ profiles, presence, nowWatching, isAudio, now }) {
  const byId = new Map((profiles || []).map(p => [p.id, p]));
  const playing = [];
  for (const [profileId, w] of Object.entries(nowWatching || {})) {
    if (!w || now - (w.updatedAt || 0) > PLAYING_WINDOW_MS) continue;
    playing.push({
      profileId, updatedAt: w.updatedAt,
      row: {
        name: byId.get(profileId)?.name || w.profileName || profileId,
        doing: isAudio(w.id) ? 'listening' : 'watching',
        title: w.title || '',
        percent: w.duration > 0 ? Math.round((w.currentTime / w.duration) * 100) : null,
        itemId: w.id,
      },
    });
  }
  playing.sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Set(playing.map(p => p.profileId));
  const browsing = Object.entries(presence || {})
    .filter(([profileId, connections]) => connections > 0 && !seen.has(profileId) && byId.has(profileId))
    .map(([profileId]) => ({ name: byId.get(profileId).name || profileId, doing: 'browsing' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows = [...playing.map(p => p.row), ...browsing];
  return {
    counts: {
      online: rows.length,
      watching: rows.filter(r => r.doing === 'watching').length,
      listening: rows.filter(r => r.doing === 'listening').length,
    },
    people: rows,
  };
}

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

// Values that are missing (a source that failed or is not set up) are skipped.
function busyItems({ downloads, conversion, organizer, scan, backup, parity, transcription, games } = {}) {
  const items = [];
  if (downloads > 0) items.push({ key: 'downloads', label: 'Downloads', detail: `${downloads} downloading` });
  if (conversion?.status === 'running' && !conversion.waitingReason) {
    const name = conversion.current ? conversion.current.replace(/\.[^.]+$/, '') : '';
    items.push({ key: 'conversion', label: 'Conversion', detail: name ? `Converting ${name}` : 'Converting' });
  }
  const state = organizer?.activity?.state;
  if (state && state !== 'idle') items.push({ key: 'organizer', label: 'Organizer', detail: organizer.activity.detail || capitalize(state) });
  if (scan?.running) items.push({ key: 'scan', label: 'Library scan', detail: 'Scanning the library' });
  if (backup === true) items.push({ key: 'backup', label: 'Nightly backup', detail: 'Running now' });
  if (parity === true) items.push({ key: 'parity', label: 'Parity sync', detail: 'Syncing now' });
  if (transcription === true) items.push({ key: 'transcription', label: 'Read-along', detail: 'Transcribing audiobooks' });
  if (games?.length) items.push({ key: 'games', label: 'Game servers', detail: games.join(', ') });
  return items;
}

function playingSentence({ watching = 0, listening = 0 }) {
  const total = watching + listening;
  if (!total) return '';
  if (total === 1) return `Someone is ${listening ? 'listening' : 'watching'} right now.`;
  if (watching && listening) return `${total} people are watching or listening right now.`;
  return `${total} people are ${listening ? 'listening' : 'watching'} right now.`;
}

// null = go ahead. Otherwise the 409 body: the caller asks the person and sends force.
function restartRefusal({ force, playing }) {
  if (force) return null;
  const sentence = playingSentence(playing || {});
  return sentence ? { ok: false, playing, error: sentence } : null;
}

// The game servers run as blue's own services, which the app cannot ask systemd
// about; their process names are visible in /proc (comm is cut to 15 characters).
const GAME_SERVERS = [[/^FactoryServer/, 'Satisfactory'], [/^PalServer/, 'Palworld'], [/^valheim_server/, 'Valheim']];
async function runningGameServers({ procDir = '/proc' } = {}) {
  let entries;
  try { entries = await fs.promises.readdir(procDir); } catch { return []; }
  const found = new Set();
  await Promise.all(entries.filter(e => /^\d+$/.test(e)).map(async pid => {
    let comm;
    try { comm = (await fs.promises.readFile(path.join(procDir, pid, 'comm'), 'utf8')).trim(); } catch { return; }
    for (const [pattern, name] of GAME_SERVERS) if (pattern.test(comm)) found.add(name);
  }));
  return GAME_SERVERS.map(([, name]) => name).filter(name => found.has(name));
}

function createActivity({ profiles, presence, nowWatching, isAudio, busy = {}, now = Date.now, cacheMs = 15_000 }) {
  let cached = null, cachedAt = 0, pending = null;
  const current = () => people({ profiles: profiles(), presence: presence(), nowWatching: nowWatching(), isAudio, now: now() });

  async function busyList() {
    if (cached && now() - cachedAt < cacheMs) return cached;
    if (!pending) {
      pending = (async () => {
        const values = {};
        await Promise.all(Object.entries(busy).map(async ([key, source]) => {
          try { values[key] = await source(); } catch { /* one source failing hides nothing else */ }
        }));
        cached = busyItems(values); cachedAt = now();
        return cached;
      })().finally(() => { pending = null; });
    }
    return pending;
  }

  async function snapshot() {
    const { counts, people: rows } = current();
    return { counts, people: rows, busy: await busyList() };
  }

  function playing() {
    const { watching, listening } = current().counts;
    return { watching, listening };
  }

  return { snapshot, playing };
}

module.exports = { people, busyItems, playingSentence, restartRefusal, runningGameServers, createActivity, PLAYING_WINDOW_MS };
