// Content requests: users ask for titles, admin fulfills via Downloads.
// One JSON file for all requests. Factory module, pattern: profile-data.js.
const path = require('path');
const crypto = require('crypto');

const VALID_STATUS = ['pending', 'downloading', 'fulfilled', 'declined'];
const VALID_TYPES = ['movie', 'show'];
const OPEN_CAP = 15;
const TITLE_MAX = 200;
const NOTE_MAX = 300;

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// "Dune Part Three (2026)" / "Dune Part Three 2026" -> { title, year }
function splitYear(raw) {
  const cleaned = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = cleaned.match(/^(.*?)[\s(]+((?:19|20)\d{2})\)?$/);
  if (m && m[1].trim()) return { title: m[1].trim(), year: m[2] };
  return { title: cleaned, year: null };
}

module.exports = function createRequests({ DATA_DIR, loadJSON, saveJSON }) {
  const FILE = path.join(DATA_DIR, 'requests.json');
  const stored = loadJSON(FILE, { requests: [] });
  let requests = Array.isArray(stored.requests) ? stored.requests : [];

  function persist() {
    saveJSON(FILE, { requests });
  }

  function isOpen(r) {
    return r.status === 'pending' || r.status === 'downloading';
  }

  function list({ profileId, isAdmin } = {}) {
    const visible = isAdmin ? requests : requests.filter(r => r.profileId === profileId);
    return [...visible].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function get(id) {
    return requests.find(r => r.id === id) || null;
  }

  function create({ title, year, type, note, profileId, profileName }) {
    const parsed = splitYear(title);
    const cleanTitle = parsed.title.slice(0, TITLE_MAX);
    const cleanYear = String(year || parsed.year || '').match(/^(?:19|20)\d{2}$/) ? String(year || parsed.year) : null;
    if (!cleanTitle) return { ok: false, code: 'invalid', error: 'Request needs a title' };
    const cleanType = VALID_TYPES.includes(type) ? type : 'unknown';

    const dupe = requests.find(r => r.status !== 'declined' &&
      normTitle(r.title) === normTitle(cleanTitle) &&
      (r.type === cleanType || r.type === 'unknown' || cleanType === 'unknown'));
    if (dupe) return { ok: false, code: 'duplicate', request: dupe, error: `Already requested by ${dupe.profileName || 'someone'}` };

    const open = requests.filter(r => r.profileId === profileId && isOpen(r)).length;
    if (open >= OPEN_CAP) return { ok: false, code: 'cap', error: `Limit of ${OPEN_CAP} open requests reached` };

    const now = Date.now();
    const request = {
      id: 'req_' + crypto.randomBytes(6).toString('hex'),
      title: cleanTitle,
      year: cleanYear,
      type: cleanType,
      note: String(note || '').slice(0, NOTE_MAX),
      profileId: profileId || '',
      profileName: profileName || '',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      matchedId: null,
      omdb: null,
    };
    requests.unshift(request);
    persist();
    return { ok: true, request };
  }

  function attachOmdb(id, omdb) {
    const r = get(id);
    if (!r) return null;
    r.omdb = omdb;
    persist();
    return r;
  }

  function setStatus(id, status) {
    if (!VALID_STATUS.includes(status)) return null;
    const r = get(id);
    if (!r) return null;
    r.status = status;
    r.updatedAt = Date.now();
    persist();
    return r;
  }

  function remove(id, { profileId, isAdmin } = {}) {
    const r = get(id);
    if (!r) return false;
    if (!isAdmin && !(r.status === 'pending' && r.profileId === profileId)) return false;
    requests = requests.filter(x => x.id !== id);
    persist();
    return true;
  }

  // Match a request against a library item: same normalized title (movie
  // title or show name, year stripped), and year agrees when both known.
  function itemMatches(item, req) {
    if (req.type === 'movie' && item.type !== 'movie') return false;
    if (req.type === 'show' && item.type === 'movie') return false;
    const names = item.showName
      ? [splitYear(item.showName).title, item.showName]
      : [item.title];
    if (!names.some(n => normTitle(n) === normTitle(req.title))) return false;
    if (req.year && item.year && !item.showName && String(item.year) !== String(req.year)) return false;
    return true;
  }

  function findInLibrary(library, title, type) {
    const parsed = splitYear(title);
    const req = { title: parsed.title, year: parsed.year, type: VALID_TYPES.includes(type) ? type : 'unknown' };
    return (library || []).find(item => itemMatches(item, req)) || null;
  }

  // After a scan: flip open requests whose title now exists to fulfilled.
  function matchLibrary(library) {
    let changed = 0;
    for (const r of requests) {
      if (!isOpen(r)) continue;
      const match = (library || []).find(item => itemMatches(item, r));
      if (!match) continue;
      r.status = 'fulfilled';
      r.matchedId = match.id;
      r.updatedAt = Date.now();
      changed++;
    }
    if (changed) persist();
    return changed;
  }

  return { list, get, create, attachOmdb, setStatus, remove, matchLibrary, findInLibrary };
};
