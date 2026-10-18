// Content requests: viewers ask for titles, admins track them. Registered by
// server.js with explicit dependencies.
module.exports = function registerRequestRoutes(app, {
  requireAuth, ensureLibrary, requireAdminSession, getSession, profileName, requests, libraryItems,
  fetchOmdbData, saveOmdbCache, notifyClients,
}) {
  app.get('/api/requests', requireAuth, (req, res) => {
    const session = getSession(req);
    const isAdmin = session.role === 'admin';
    res.json({ ok: true, isAdmin, requests: requests.list({ profileId: session.profileId, isAdmin }) });
  });

  app.post('/api/requests', requireAuth, ensureLibrary, async (req, res) => {
    const session = getSession(req);
    const { title, type, note } = req.body || {};
    const available = requests.findInLibrary(libraryItems(), title, type);
    if (available) {
      return res.status(409).json({ ok: false, code: 'available', itemId: available.id, error: `"${available.showName || available.title}" is already in the library` });
    }
    const result = requests.create({ title, type, note, profileId: session.profileId, profileName: profileName(session.profileId) || session.profileId });
    if (!result.ok) {
      const status = result.code === 'duplicate' ? 409 : (result.code === 'cap' ? 429 : 400);
      return res.status(status).json({ ok: false, code: result.code, error: result.error, request: result.request });
    }
    // Best-effort poster/canonical title so the admin sees what's being asked.
    try {
      const omdb = await fetchOmdbData(result.request.title, result.request.year, result.request.type === 'unknown' ? undefined : result.request.type);
      if (omdb && !omdb._miss) {
        requests.attachOmdb(result.request.id, { title: omdb.omdbTitle || null, year: omdb.omdbYear || null, posterUrl: omdb.posterUrl || null });
        saveOmdbCache();
      }
    } catch {}
    notifyClients('requests-updated');
    res.json({ ok: true, request: requests.get(result.request.id) });
  });

  app.patch('/api/requests/:id', requireAdminSession, (req, res) => {
    const updated = requests.setStatus(req.params.id, req.body?.status);
    if (!updated) return res.status(404).json({ ok: false, error: 'Unknown request or status' });
    notifyClients('requests-updated');
    res.json({ ok: true, request: updated });
  });

  app.delete('/api/requests/:id', requireAuth, (req, res) => {
    const session = getSession(req);
    const removed = requests.remove(req.params.id, { profileId: session.profileId, isAdmin: session.role === 'admin' });
    if (!removed) return res.status(403).json({ ok: false, error: 'Only pending requests you created can be removed' });
    notifyClients('requests-updated');
    res.json({ ok: true });
  });
};
