// Dashboard data (background jobs, streaming history, library growth) and the
// player's end-of-viewing report. Registered by server.js with explicit dependencies.
const { weeklyAdditions, storageSeries } = require('../library-growth');

const titleOf = item => (item.showName
  ? `${item.showName}${item.epInfo ? ` · S${item.epInfo.season} E${item.epInfo.episode}` : ''}`
  : item.title || item.id);

module.exports = function registerDashboardRoutes(app, {
  requireAuth, requirePermission, getSession, profileName, scanLibrary, jobs, playbackHistory, storageHistory, now = Date.now,
}) {
  app.get('/api/dashboard/jobs', requirePermission('canDashboard'), async (_req, res) => {
    res.json(await jobs.snapshot());
  });

  app.get('/api/dashboard/streaming', requirePermission('canDashboard'), (req, res) => {
    const days = Math.max(1, Math.min(120, parseInt(req.query.days, 10) || 30));
    res.json(playbackHistory.summary({ days }));
  });

  app.get('/api/dashboard/library', requirePermission('canDashboard'), (_req, res) => {
    const library = scanLibrary();
    const recent = [...library].filter(i => i.addedAt && i.addedAt <= now()).sort((a, b) => b.addedAt - a.addedAt).slice(0, 8)
      .map(i => ({ id: i.id, title: titleOf(i), kind: i.mediaKind || i.type, addedAt: i.addedAt }));
    res.json({ weeks: weeklyAdditions(library, { now: now() }), storage: storageSeries(storageHistory(), { now: now() }), recent });
  });

  // Sent by the player (as a beacon) when a viewing ends.
  app.post('/api/playback/report', requireAuth, (req, res) => {
    const item = scanLibrary().find(i => i.id === req.body?.itemId);
    if (item) {
      const session = getSession(req);
      playbackHistory.record(req.body, { profileName: profileName(session?.profileId) || session?.profileId || '', title: titleOf(item) });
    }
    res.status(204).end();
  });
};
