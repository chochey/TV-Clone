// Fixed-size ring buffer for admin event logs (the Logs page's Logins, Streams, Scans, Errors).
// Newest entry first. With `file`, the entries are loaded at start and saved shortly after each
// burst of pushes, so a restart no longer empties the page ("Nothing logged yet" after a deploy day).
module.exports = function createLogRing(maxEntries, { file = null, loadJSON = null, saveJSON = null, later = fn => setTimeout(fn, 1000).unref?.() } = {}) {
  const entries = [];
  if (file && loadJSON) {
    const stored = loadJSON(file, []);
    if (Array.isArray(stored)) entries.push(...stored.filter(e => e && typeof e === 'object').slice(0, maxEntries));
  }
  let saving = false;
  function scheduleSave() {
    if (!file || !saveJSON || saving) return;
    saving = true;
    later(() => { saving = false; saveJSON(file, entries); });
  }
  return {
    entries,
    push(entry) {
      entries.unshift({ timestamp: Date.now(), ...entry });
      if (entries.length > maxEntries) entries.pop();
      scheduleSave();
    },
    get() { return entries; },
  };
};
