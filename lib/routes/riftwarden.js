// Rift Warden (permission canRiftWarden): the launcher for the game Chochey is making, downloadable
// from ChocheyTV. The files are the update server's own release folder on the media pool
// (/mnt/media/SharedFolder/riftwarden-server/files, served raw on :8088 for the launcher's updates),
// so a new release shows here without a deploy. Each launcher download is logged in "Saved files".
const fs = require('fs');
const path = require('path');

const DEFAULT_LAUNCHER = 'RiftWardenLauncher.exe';
const plainExe = name => typeof name === 'string' && /^[A-Za-z0-9._-]+\.exe$/.test(name) ? name : null;

module.exports = function registerRiftWardenRoutes(app, { requirePermission, dir, onSaved = () => {} }) {
  function release() {
    let latest = {};
    try { latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')) || {}; } catch { /* the launcher alone is enough */ }
    const file = plainExe(latest.launcher?.url) || DEFAULT_LAUNCHER;
    // Follow links only to a regular file that really lives in the release folder: a link planted
    // there must not hand out a file from anywhere else the app can read.
    let launcherPath, bytes;
    try {
      const root = fs.realpathSync(dir);
      launcherPath = fs.realpathSync(path.join(dir, file));
      const st = fs.statSync(launcherPath);
      if (!launcherPath.startsWith(root + path.sep) || !st.isFile()) throw new Error('outside the release folder');
      bytes = st.size;
    } catch { return { latest, file, missing: true }; }
    return { latest, file, launcherPath, bytes };
  }

  app.get('/api/riftwarden', requirePermission('canRiftWarden'), (_req, res) => {
    const r = release();
    if (r.missing) return res.json({ ok: false, error: 'not-available' });
    res.json({
      ok: true,
      version: typeof r.latest.version === 'string' ? r.latest.version : null,
      date: typeof r.latest.date === 'string' ? r.latest.date : null,
      notes: typeof r.latest.notes === 'string' ? r.latest.notes : '',
      launcher: { file: r.file, bytes: r.bytes, version: r.latest.launcher?.version ?? null, sha256: r.latest.launcher?.sha256 || null },
    });
  });

  // Opened once, refusing a link at that moment (O_NOFOLLOW on the already-resolved path), checked on
  // the open handle and streamed from it: swapping the file for a link between the check and the send
  // cannot hand out anything else. HEAD only asks for the size, so it is not logged.
  app.get('/api/riftwarden/launcher', requirePermission('canRiftWarden'), (req, res) => {
    const r = release();
    const unavailable = () => res.status(404).send('The launcher is not available right now');
    if (r.missing) return unavailable();
    let fd, size;
    try {
      fd = fs.openSync(r.launcherPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error('not a regular file');
      size = st.size;
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      return unavailable();
    }
    res.attachment(r.file);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Length', size);
    if (req.method === 'HEAD') { fs.closeSync(fd); return res.end(); }
    const started = Date.now();
    let reported = false;
    const report = completed => {
      if (reported) return;
      reported = true;
      try {
        onSaved({ req, id: 'riftwarden-launcher', filePath: r.launcherPath, completed, ms: Date.now() - started,
          range: false, title: 'Rift Warden launcher' });
      } catch { /* logging must never take the request (or the server) down */ }
    };
    res.on('finish', () => report(true));
    res.on('close', () => report(false));
    const stream = fs.createReadStream(null, { fd, autoClose: true });
    stream.on('error', () => { report(false); res.destroy(); });
    stream.pipe(res);
  });
};
