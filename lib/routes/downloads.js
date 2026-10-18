// Downloads API: qBittorrent status, search, the torrent list (with import
// status), adding, pausing, resuming and deleting torrents, and Mullvad paid
// time. Registered by server.js with explicit dependencies.
const { classifyTorrentUrl } = require('../torrent-url');
const { splitTorrentAdds, duplicateAddResult } = require('../torrent-add');

module.exports = function registerDownloadRoutes(app, { requirePermission, requireQbt, qbt, qbtAuth, qbtJson, downloadsWithStatus, mullvad }) {
  app.get('/api/vpn/status', requirePermission('canDownload'), async (_req, res) => {
    res.json(await mullvad.status());
  });

  // qBittorrent status
  app.get('/api/qbt/status', requirePermission('canDownload'), requireQbt, async (_req, res) => {
    try {
      const ok = await qbtAuth();
      res.json({ connected: ok });
    } catch { res.json({ connected: false }); }
  });

  // Search plugins
  app.get('/api/qbt/search/plugins', requirePermission('canDownload'), requireQbt, async (_req, res) => {
    try {
      const r = await qbt('GET', '/api/v2/search/plugins');
      res.json(qbtJson(r));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Start search
  app.post('/api/qbt/search/start', requirePermission('canDownload'), requireQbt, async (req, res) => {
    try {
      const { pattern, category, plugins } = req.body;
      if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 300) return res.status(400).json({ error: 'Enter a search of 1–300 characters.' });
      const body = `pattern=${encodeURIComponent(pattern)}&category=${encodeURIComponent(category || 'all')}&plugins=${encodeURIComponent(plugins || 'all')}`;
      const r = await qbt('POST', '/api/v2/search/start', body);
      res.json(qbtJson(r));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Get search results
  app.get('/api/qbt/search/results', requirePermission('canDownload'), requireQbt, async (req, res) => {
    try {
      const { id } = req.query;
      if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'Invalid search ID' });
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const r = await qbt('GET', `/api/v2/search/results?id=${id}&offset=${offset}&limit=${limit}`);
      res.json(qbtJson(r));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Stop search
  app.post('/api/qbt/search/stop', requirePermission('canDownload'), requireQbt, async (req, res) => {
    try {
      if (!/^\d+$/.test(String(req.body.id))) return res.status(400).json({ error: 'Invalid search ID' });
      await qbt('POST', '/api/v2/search/stop', `id=${encodeURIComponent(req.body.id)}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // List torrents
  app.get('/api/qbt/torrents', requirePermission('canDownload'), requireQbt, async (_req, res) => {
    try {
      const r = await qbt('GET', '/api/v2/torrents/info');
      const torrents = qbtJson(r);
      if (!Array.isArray(torrents)) throw new Error('Downloader returned an invalid torrent list.');
      res.json(await downloadsWithStatus(torrents));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Add torrent
  app.post('/api/qbt/torrents/add', requirePermission('canDownload'), requireQbt, async (req, res) => {
    try {
      const { urls, savepath } = req.body;
      if (!urls || typeof urls !== 'string') return res.status(400).json({ ok: false, error: 'Missing torrent URL' });
      const cleanUrls = urls.trim();
      // Classify every line (qBittorrent accepts newline-separated adds; the app
      // only ever sends one, but validate them all rather than trust that).
      // 'page' is the important reject: qBittorrent would accept a details-page
      // URL, reply "Ok.", then silently fail to bdecode it, leaving the torrent
      // stuck at "Fetching metadata" while the UI reported success. See
      // lib/torrent-url.js for the torrentproject case that motivated this.
      const requestedUrls = cleanUrls.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
      const kinds = requestedUrls.map(classifyTorrentUrl);
      if (kinds.some((k) => k === 'page')) {
        return res.status(400).json({ ok: false, error: 'That result links to a web page, not a downloadable torrent. Pick a different result or paste a magnet link.' });
      }
      if (kinds.some((k) => k === 'invalid') || kinds.length === 0) {
        return res.status(400).json({ ok: false, error: 'Use a magnet link or torrent URL' });
      }
      let newUrls = requestedUrls, duplicateResult = null;
      if (kinds.includes('magnet')) {
        const torrents = qbtJson(await qbt('GET', '/api/v2/torrents/info'));
        const split = splitTorrentAdds(requestedUrls, torrents);
        newUrls = split.newUrls;
        if (split.existingIndexes.length) {
          // Receipt reconciliation requires the complete authoritative snapshot.
          // Passing only matched rows would incorrectly prune other receipts.
          const decorated = await downloadsWithStatus(torrents);
          duplicateResult = duplicateAddResult(split.existingIndexes.map(index => decorated[index]), newUrls.length);
        }
      }
      if (!newUrls.length) return res.json(duplicateResult);
      let body = `urls=${encodeURIComponent(newUrls.join('\n'))}`;
      if (savepath) body += `&savepath=${encodeURIComponent(savepath)}`;
      const r = await qbt('POST', '/api/v2/torrents/add', body);
      if (r.status >= 400 || r.data !== 'Ok.') return res.status(502).json({ ok: false, error: r.data || 'qBittorrent rejected the torrent' });
      res.json(duplicateResult || { ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Pause torrent
  app.post('/api/qbt/torrents/pause', requirePermission('canDownload'), requireQbt, async (req, res) => {
    try {
      if (typeof req.body.hashes !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?(?:\|[a-f0-9]{40}(?:[a-f0-9]{24})?)*$/i.test(req.body.hashes)) {
        return res.status(400).json({ error: 'Select a valid download.' });
      }
      await qbt('POST', '/api/v2/torrents/stop', `hashes=${encodeURIComponent(req.body.hashes)}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Resume torrent
  app.post('/api/qbt/torrents/resume', requirePermission('canDownload'), requireQbt, async (req, res) => {
    try {
      if (typeof req.body.hashes !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?(?:\|[a-f0-9]{40}(?:[a-f0-9]{24})?)*$/i.test(req.body.hashes)) {
        return res.status(400).json({ error: 'Select a valid download.' });
      }
      await qbt('POST', '/api/v2/torrents/start', `hashes=${encodeURIComponent(req.body.hashes)}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Delete torrent
  app.post('/api/qbt/torrents/delete', requirePermission('canDownload'), requireQbt, async (req, res) => {
    try {
      if (typeof req.body.hashes !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?(?:\|[a-f0-9]{40}(?:[a-f0-9]{24})?)*$/i.test(req.body.hashes)) {
        return res.status(400).json({ error: 'Select a valid download.' });
      }
      const { hashes, deleteFiles } = req.body;
      await qbt('POST', '/api/v2/torrents/delete', `hashes=${encodeURIComponent(hashes)}&deleteFiles=${deleteFiles === true ? 'true' : 'false'}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
