// Episode index routes: the missing-episode report, its OMDb refresh, and the
// daily new-episode tracker. One diff engine (lib/episode-index.js); the only
// traffic is OMDb metadata. Registered by server.js with explicit dependencies.
module.exports = function registerEpisodeRoutes(app, {
  requirePermission, ensureLibrary, episodeIndex, buildHoldings, scanLibrary, getShowMeta,
  notifyClients, notifyLog, loadAlerts, saveAlerts, log = console.log, error = console.error,
}) {
  let refreshRunning = false;
  let refreshProgress = null;
  let refreshError = '';

  app.get('/api/episodes/report', requirePermission('canEpisodes'), ensureLibrary, async (_req, res) => {
    // Cache-only pass (budget 0) — instant, never spends OMDb calls.
    const report = await episodeIndex.buildReport({
      holdings: buildHoldings(scanLibrary() || []),
      getShowMeta,
      budget: 0,
    });
    res.json({ ok: true, refreshing: refreshRunning, refreshProgress, refreshError, ...report });
  });

  app.post('/api/episodes/refresh', requirePermission('canEpisodes'), ensureLibrary, (req, res) => {
    if (refreshRunning) return res.json({ ok: true, started: false, refreshing: true });
    refreshRunning = true;
    refreshError = '';
    refreshProgress = null;
    const budget = Math.max(1, Math.min(500, parseInt(req.body?.budget, 10) || 300));
    (async () => {
      try {
        const report = await episodeIndex.buildReport({
          holdings: buildHoldings(scanLibrary() || []),
          getShowMeta,
          budget,
          onProgress: progress => { refreshProgress = progress; },
        });
        log(`[Episodes] Refresh done: ${report.budgetUsed} OMDb calls, ${report.staleSlots} slots still stale`);
      } catch (e) {
        refreshError = 'Episode check failed. Please try again.';
        error('[Episodes] Refresh failed:', e.message);
      } finally {
        refreshRunning = false;
        notifyClients('episodes-updated');
      }
    })();
    res.json({ ok: true, started: true, refreshing: true });
  });

  // Daily tracker: for ongoing shows, refresh the newest season and notify
  // once per newly-aired episode that the library doesn't have.
  const alertSeen = loadAlerts();
  async function episodeTrackerTick() {
    const report = await episodeIndex.buildReport({
      holdings: buildHoldings(scanLibrary() || []),
      getShowMeta,
      budget: 80,
      onlyOngoing: true,
    });
    const now = Date.now();
    const RECENT = 14 * 86_400_000;
    let pushed = 0;
    for (const show of report.shows) {
      const fresh = [];
      for (const s of show.seasons) {
        for (const m of s.missing) {
          const airTs = m.released ? Date.parse(m.released) : NaN;
          if (!Number.isFinite(airTs) || now - airTs > RECENT) continue;
          const key = `${show.imdbID}|${s.season}|${m.episode}`;
          if (alertSeen[key]) continue;
          alertSeen[key] = now;
          fresh.push({ season: s.season, ...m });
        }
      }
      if (!fresh.length) continue;
      pushed += fresh.length;
      const first = fresh[0];
      const code = `S${String(first.season).padStart(2, '0')}E${String(first.episode).padStart(2, '0')}`;
      notifyLog.push({
        type: 'episode',
        title: `New episode: ${show.show}`,
        body: fresh.length === 1
          ? `${code}${first.title ? ` — ${first.title}` : ''} aired ${first.released} and isn't in the library yet.`
          : `${fresh.length} new episodes aired (latest ${code}) and aren't in the library yet.`,
        audience: 'episodes',
      });
    }
    if (pushed) {
      saveAlerts(alertSeen);
      notifyClients('notifications-updated');
      log(`[Episodes] Tracker: ${pushed} new episode alert(s)`);
    }
  }

  return { episodeTrackerTick };
};
