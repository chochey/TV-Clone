// Per-profile lists: watch history (read-only here), the "up next" queue, the
// watchlist (a lasting save-for-later list, separate from the queue) and the
// items hidden from Continue Watching / Recently Added. Every route acts on the
// signed-in profile only. Registered by server.js with explicit dependencies.
module.exports = function registerProfileListRoutes(app, { requireAuth, getRequestProfile, loadProfileData, saveProfileData }) {
  // Runs handler(data, req, profileId) for the request's profile, or refuses.
  const reading = handler => (req, res) => {
    const profileId = getRequestProfile(req);
    if (!profileId) return res.status(403).json({ error: 'Cannot access other profiles' });
    res.json(handler(loadProfileData(profileId), req));
  };
  const writing = (handler, { needsId = false } = {}) => (req, res) => {
    if (needsId && !req.body?.id) return res.status(400).json({ error: 'Missing id' });
    const profileId = getRequestProfile(req);
    if (!profileId) return res.status(403).json({ error: 'Cannot modify other profiles' });
    const data = loadProfileData(profileId);
    const reply = handler(data, req);
    saveProfileData(profileId, data);
    res.json(reply);
  };
  const addOnce = (list, id) => (list.includes(id) ? list : [...list, id]);

  app.get('/api/history', requireAuth, reading(data => data.history || []));

  app.get('/api/queue', requireAuth, reading(data => data.queue || []));
  app.post('/api/queue', requireAuth, writing((data, req) => { data.queue = Array.isArray(req.body.queue) ? req.body.queue : []; return { ok: true }; }));
  app.post('/api/queue/add', requireAuth, writing((data, req) => {
    data.queue = addOnce(data.queue || [], req.body.id); return { ok: true, queue: data.queue };
  }, { needsId: true }));
  app.post('/api/queue/remove', requireAuth, writing((data, req) => {
    data.queue = (data.queue || []).filter(q => q !== req.body.id); return { ok: true, queue: data.queue };
  }));

  app.get('/api/watchlist', requireAuth, reading(data => data.watchlist || []));
  app.post('/api/watchlist/add', requireAuth, writing((data, req) => {
    data.watchlist = addOnce(data.watchlist || [], req.body.id); return { ok: true, watchlist: data.watchlist };
  }, { needsId: true }));
  app.post('/api/watchlist/remove', requireAuth, writing((data, req) => {
    data.watchlist = (data.watchlist || []).filter(w => w !== req.body.id); return { ok: true, watchlist: data.watchlist };
  }));

  app.get('/api/dismissed', requireAuth, reading(data => data.dismissed || { continueWatching: {}, recentlyAdded: {} }));
  for (const [path, shelf] of [['continue-watching', 'continueWatching'], ['recently-added', 'recentlyAdded']]) {
    app.post(`/api/dismissed/${path}/:id`, requireAuth, writing((data, req) => { data.dismissed[shelf][req.params.id] = true; return { ok: true }; }));
    app.delete(`/api/dismissed/${path}/:id`, requireAuth, writing((data, req) => { delete data.dismissed[shelf][req.params.id]; return { ok: true }; }));
  }
};
