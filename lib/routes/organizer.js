// Organizer page API: the log viewer, title aliases ("Fix & retry"), retry
// requests, the review queue and clearing leftover files. Registered by
// server.js with explicit dependencies; returns readOrganizerLogLines for the
// download status code, which reads the same log.
const fs = require('fs');
const path = require('path');
const organizerTools = require('../organizer-tools');
const organizerStatus = require('../organizer-status');
const organizerClear = require('../organizer-clear');
const organizerShare = require('../organizer-share');
const { organizerActivity, filterActivity } = require('../organizer-activity');

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

module.exports = function registerOrganizerRoutes(app, {
  requirePermission, requireAdminSession, loadJSON, saveJSONSync,
  logPath, statusFile, aliasFile, sourceDir, retryDir, libraryPaths, libraryRoots = () => [], log = console.log,
}) {
  const getAliases = () => organizerTools.loadAliases(loadJSON, aliasFile);
  function saveAliases(aliases) {
    try { fs.mkdirSync(path.dirname(aliasFile), { recursive: true }); } catch {}
    return organizerTools.saveAliases(saveJSONSync, aliasFile, aliases);
  }

  // Read only the tail of the organizer log: it is kept up to 5 MB and these
  // endpoints are hit on every refresh.
  function readOrganizerLogLines(maxBytes = 1536 * 1024) {
    try {
      const st = fs.statSync(logPath);
      const start = Math.max(0, st.size - maxBytes);
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      let text = buf.toString('utf-8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
      return text.split('\n').filter(l => l.trim());
    } catch {
      return [];
    }
  }

  function logTimestamp(line) {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    if (!m) return 0;
    const t = Date.parse(m[1].replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
  }

  app.get('/api/organizer/logs', requirePermission('canOrganizer'), async (req, res) => {
    const lines = Math.min(parseInt(req.query.lines) || 200, 1000);
    const maxEntries = Math.min(parseInt(req.query.entries) || 200, 1000);
    // Feed names (imports, problems, organizer) and the raw-log names they replaced (moves, errors, scans).
    const filter = { imports: 'moves', problems: 'errors', organizer: 'scans' }[req.query.filter] || req.query.filter || 'all';
    const q = String(req.query.q || '').toLowerCase().slice(0, 100);
    try {
      if (!fs.existsSync(logPath)) return res.json({ ok: false, error: 'Log file not found' });
      const allLines = readOrganizerLogLines();
      const isHeartbeat = l => /Still watching\.\.\./.test(l);
      // "EVENT: {...}" lines are the machine-readable twins of the lines around them: never shown, never counted.
      const isEvent = l => /(?:^|\] )EVENT: \{/.test(l);

      // Activity summary over the tail: heartbeat freshness + last 24h counts
      const meta = { lastHeartbeat: 0, lastActivity: 0, moves24h: 0, skips24h: 0, errors24h: 0, status: null };
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      for (const l of allLines) {
        if (isEvent(l)) continue;
        const ts = logTimestamp(l);
        if (isHeartbeat(l)) { if (ts > meta.lastHeartbeat) meta.lastHeartbeat = ts; continue; }
        if (ts > meta.lastActivity) meta.lastActivity = ts;
        if (ts < dayAgo) continue;
        if (/Moved ->/.test(l)) meta.moves24h++;
        else if (/SKIP|No confident|REVIEW: \{/i.test(l)) meta.skips24h++;
        else if (/ERROR|FAIL|rate limit/i.test(l)) meta.errors24h++;
      }

      // The status file the organizer keeps current is a better sign of life than a log line: it keeps
      // updating during a long copy. Without it (an older organizer, an unwritable folder) the log heartbeat stands.
      const status = organizerStatus.readStatus(statusFile);
      if (status) { meta.lastHeartbeat = status.updatedAt; meta.status = status; }

      const shown = allLines.filter(l => !isEvent(l));
      let out;
      if (filter === 'moves') out = shown.filter(l => /Moved ->|MOVIE.*Found|TV.*Found|Parsed:|OMDb match:|Scan complete/.test(l));
      else if (filter === 'errors') out = shown.filter(l => /SKIP|ERROR|FAIL|No confident|rate limit|REVIEW: \{/i.test(l));
      else if (filter === 'scans') out = shown.filter(l => /Scan complete|Watching|============/.test(l));
      else out = shown.filter(l => !isHeartbeat(l)); // 'all' still hides heartbeats
      if (q) out = out.filter(l => l.toLowerCase().includes(q));

      // The activity feed (lib/organizer-activity.js): the same lines as things that happened, newest first.
      const activity = organizerActivity(allLines, { sourceDir, libraryRoots: libraryRoots() });
      const newestImport = activity.find(entry => entry.kind === 'import');
      meta.lastImport = newestImport ? { at: newestImport.at, title: newestImport.title, summary: newestImport.summary } : null;
      const entries = filterActivity(activity, filter, q);
      res.json({ ok: true, lines: out.slice(-lines), total: out.length, meta, entries: entries.slice(0, maxEntries), entriesTotal: entries.length });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get('/api/organizer/aliases', requireAdminSession, (_req, res) => {
    res.json({ ok: true, aliases: getAliases(), path: aliasFile });
  });

  app.post('/api/organizer/aliases', requireAdminSession, (req, res) => {
    const aliases = getAliases();
    const saved = organizerTools.upsertAlias(aliases, req.body || {});
    if (!saved) return res.status(400).json({ ok: false, error: 'Alias needs both a parsed title and an OMDb title.' });
    saveAliases(aliases);
    res.json({ ok: true, alias: saved, aliases });
  });

  app.delete('/api/organizer/aliases/:id', requireAdminSession, (req, res) => {
    const aliases = getAliases();
    const next = aliases.filter(a => a.id !== req.params.id);
    if (next.length === aliases.length) return res.status(404).json({ ok: false, error: 'Alias not found' });
    saveAliases(next);
    res.json({ ok: true, aliases: next });
  });

  const organizerRetry = require('../organizer-retry')({
    sourceDir, spoolDir: retryDir,
    getReviewQueue: () => organizerTools.parseOrganizerFixQueue(readOrganizerLogLines(), getAliases()),
  });
  app.post('/api/organizer/retry', requireAdminSession, async (req, res) => {
    try { res.json(await organizerRetry.enqueue(req.body?.id)); }
    catch (error) { res.status(error.status || 503).json({ ok: false, error: error.status ? error.message : 'Could not queue retry' }); }
  });

  // What the review screen shows: unresolved failures, plus whatever is physically left in Share.
  // Throws an error carrying a status when the download folder cannot be read.
  async function reviewState() {
    const aliases = getAliases();
    const logLines = readOrganizerLogLines();
    const queue = organizerTools.parseOrganizerFixQueue(logLines, aliases);

    // What's physically in Share (skip qbt's working dir, dotfiles, and
    // underscore-prefixed admin parking folders like _review — the organizer
    // ignores those too). Items younger than 10 min may just be awaiting the
    // next organizer poll.
    let shareEntries = [];
    try {
      const names = (await fs.promises.readdir(sourceDir))
        .filter((n) => !n.startsWith('.') && !n.startsWith('_') && n.toLowerCase() !== 'incomplete');
      shareEntries = await Promise.all(names.map(async (name) => {
        let mtime = 0, isFile = false;
        try { const st = await fs.promises.stat(path.join(sourceDir, name)); mtime = st.mtimeMs; isFile = st.isFile(); } catch {}
        // A download that is one loose video sits in Share as "<release>.mkv", but the organizer
        // logs the release without its extension (media-organizer VIDEO_EXTENSIONS).
        const release = isFile ? name.replace(/\.(mkv|mp4|avi|m4v|webm|mov)$/i, '') : name;
        return { name, release, norm: normName(name), mtime, matched: false };
      }));
    } catch {
      throw Object.assign(new Error('Could not read the download folder. Review status is unavailable.'), { status: 503 });
    }

    // A queue entry is live if its release (or parsed title) still sits in Share.
    for (const entry of queue) {
      const src = entry.source;
      const title = normName(entry.title);
      entry.stillPresent = shareEntries.some((s) => {
        const hit = src ? (s.name === src || s.release === src) : title && s.norm.includes(title);
        if (hit && !entry.resolved) s.matched = true;
        return hit;
      });
    }

    // Unknown leftovers remain in review. Confirmed imports containing only
    // other files are listed separately; only clear-leftovers removes anything.
    const cutoff = Date.now() - 10 * 60 * 1000;
    const aged = shareEntries
      .filter((s) => !s.matched && s.mtime < cutoff)
      .map((s) => ({ name: s.name, mtime: s.mtime }));
    const { leftovers, importedLeftovers } = await organizerShare.classifyLeftovers(aged, {
      sourceDir, lines: logLines, libraryPaths: libraryPaths(),
    });
    const active = queue.filter(entry => entry.stillPresent && !entry.resolved);
    const history = queue.filter(entry => !entry.stillPresent || entry.resolved).slice(0, 100);
    return { queue: [...active, ...history], aliases, leftovers, importedLeftovers };
  }

  app.get('/api/organizer/fix-queue', requireAdminSession, async (_req, res) => {
    try { res.json({ ok: true, ...(await reviewState()), retries: await organizerRetry.snapshot() }); }
    catch (error) { res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Could not build the review queue.' }); }
  });

  // Remove the advertising and poster files an imported release left behind. The browser names
  // releases it saw under importedLeftovers; what may be cleared is worked out again here, and
  // lib/organizer-clear.js checks every file once more immediately before removing it.
  app.post('/api/organizer/clear-leftovers', requireAdminSession, async (req, res) => {
    const names = req.body?.names;
    if (!Array.isArray(names) || !names.length || names.length > 200) {
      return res.status(400).json({ ok: false, error: 'Choose which leftovers to clear.' });
    }
    try {
      const clearable = new Set((await reviewState()).importedLeftovers.map(entry => entry.name));
      const requested = [...new Set(names.map(name => String(name).slice(0, 255)))];
      const eligible = requested.filter(name => clearable.has(name));
      const outcome = eligible.length
        ? await organizerClear.clearJunk({ sourceDir, names: eligible })
        : { cleared: [], skipped: [] };
      for (const done of outcome.cleared) {
        log(`[organizer] cleared ${done.files} leftover file${done.files === 1 ? '' : 's'} from "${done.name}"${done.folderRemoved ? '' : ' (folder kept)'}`);
      }
      const stale = requested.filter(name => !clearable.has(name))
        .map(name => ({ name, reason: 'This release no longer qualifies for clearing. Refresh the list.' }));
      res.json({ ok: true, cleared: outcome.cleared, skipped: [...outcome.skipped, ...stale],
        importedLeftovers: (await reviewState()).importedLeftovers });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: error.status ? error.message : 'Could not clear the leftovers.' });
    }
  });

  return { readOrganizerLogLines };
};
