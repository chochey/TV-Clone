// Server-side download watcher: one 10 s poll of qBittorrent for the whole
// household (clients used to each poll it themselves, and missed everything
// while no tab was open). Each poll writes the readiness snapshot the
// organizer waits on, flags downloads with no video (advisory only), records
// confirmed imports, and turns state changes into notifications; a completed
// download also schedules a rescan for after the organizer has moved it.
// Factory module; server.js wires it up.
module.exports = function createDownloadWatcher({
  qbt, qbtJson, writeReadiness, downloadsWithStatus, torrentHasVideoFile,
  notifyLogLib, notifyLog, notifyClients, rescanLibraryAsync,
  log = console.error, every = setInterval, later = setTimeout, intervalMs = 10_000,
}) {
  const reviews = new Map();       // hash -> advisory note shown in Downloads
  const videoChecked = new Set();  // hashes whose file list was already inspected
  let busy = false, previous = null, readinessFailing = false;

  // A full disk must not take the watcher (or, before Oct 16, the server)
  // down: the organizer treats a stale snapshot as "wait", which is safe.
  // Say so once when writes start failing and once when they recover.
  function writeSnapshot(torrents) {
    try {
      writeReadiness(torrents);
      if (readinessFailing) { readinessFailing = false; log('[downloads] readiness snapshot is being written again'); }
    } catch (error) {
      if (!readinessFailing) log(`[downloads] could not write the readiness snapshot (the organizer waits until it can): ${error.code || error.message}`);
      readinessFailing = true;
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      let torrents;
      try { torrents = qbtJson(await qbt('GET', '/api/v2/torrents/info')); }
      catch { return; }   // qBittorrent momentarily unreachable: skip this tick
      if (!Array.isArray(torrents)) return;
      writeSnapshot(torrents);

      let reviewChanged = false;
      for (const t of torrents) {
        if (!t.hash || videoChecked.has(t.hash)) continue;
        if (t.state === 'metaDL' || t.state === 'checkingResumeData') continue;
        let files;
        try { files = qbtJson(await qbt('GET', `/api/v2/torrents/files?hash=${t.hash}`)); }
        catch { continue; }
        const hasVideo = torrentHasVideoFile(files);
        if (hasVideo === null) continue;
        videoChecked.add(t.hash);
        if (hasVideo === false) {
          // Classification is advisory only. Never pause or delete someone else's
          // downloads (or intentional music/software) based on an extension list.
          reviews.set(t.hash, 'No recognized video files. Kept in downloads; automatic media import may not apply.');
          reviewChanged = true;
        }
      }
      const live = new Set(torrents.map(t => t.hash));
      for (const h of videoChecked) if (!live.has(h)) { videoChecked.delete(h); reviews.delete(h); }
      // Record fully confirmed imports even while no Downloads tab is open.
      // This only changes visibility bookkeeping; qBittorrent keeps every entry.
      await downloadsWithStatus(torrents);
      if (reviewChanged) notifyClients('downloads-updated');

      const now = notifyLogLib.torrentStates(torrents);
      const events = notifyLogLib.diffDownloads(previous, now);
      previous = now;
      if (!events.length) return;
      for (const e of events) notifyLog.push({ ...e, audience: 'download' });
      notifyClients('notifications-updated');
      if (events.some(e => e.type === 'complete')) {
        later(() => { rescanLibraryAsync('post-download').catch(() => {}); }, 90_000);
      }
    } finally { busy = false; }
  }

  function start() {
    const timer = every(() => { tick().catch(error => log(`[downloads] watcher tick failed: ${error.message}`)); }, intervalMs);
    timer?.unref?.();
    return timer;
  }
  return { reviews, tick, start };
};
