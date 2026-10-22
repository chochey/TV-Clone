// What the server is busy with in the background, for the dashboard: audiobook
// transcription (tools/readalong/transcript, run outside the server; read from
// its work folder), the nightly collections lookup, seek-bar thumbnails, Data
// Saver copies and library scans. Each source is reported on its own, so one
// that fails never hides the rest.
const fs = require('fs');
const path = require('path');

module.exports = function createDashboardJobs({ transcribeDir, readAlongDir, audioLiteDir, isActive,
  collections, sprites, dataSaver, libraryScan, dataDir = null, poolRoots = ['/mnt/media'], now = Date.now }) {
  // The nightly backup's receipt (lib/reliability.js writes it): when, where, whether it verified,
  // and whether the destination is on the media pool rather than the system disk.
  async function backup() {
    if (!dataDir) return { missing: true };
    let r;
    try { r = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'backup-receipt.json'), 'utf8')); } catch { return { missing: true }; }
    const at = Date.parse(r.at) || 0;
    const where = r.backupRoot || null;
    const ageHours = Math.round((now() - at) / 3600000);
    return { at, ok: !!r.ok, verified: !!r.verified, error: r.error || null, where, fileCount: r.fileCount || 0, bytes: r.bytes || 0,
      kept: r.kept || 0, onPool: !!where && poolRoots.some(root => where === root || where.startsWith(root.replace(/\/$/, '') + '/')),
      ageHours, stale: ageHours > 36 };
  }
  async function transcription() {
    let queue = [];
    try { queue = JSON.parse(await fs.promises.readFile(path.join(transcribeDir, 'queue.json'), 'utf8')); } catch {}
    const done = book => fs.existsSync(path.join(readAlongDir, `${book.id}.json`));
    const chaptersDone = async book => {
      try { return (await fs.promises.readdir(path.join(transcribeDir, 'books', book.id))).filter(f => /^words-\d+\.json$/.test(f)).length; }
      catch { return -1; }
    };
    const waiting = queue.filter(b => !done(b));
    let current = null, rest = waiting;
    for (const [i, book] of waiting.entries()) {
      const n = await chaptersDone(book);
      if (n >= 0) { current = { title: book.title, chaptersDone: n, chaptersTotal: book.chapters || 0 }; rest = waiting.slice(i + 1); break; }
    }
    return { active: await isActive('tvclone-transcribe.service').catch(() => false), booksTotal: queue.length,
      booksDone: queue.length - waiting.length, current, next: rest.slice(0, 2).map(b => b.title) };
  }

  async function liteUsage() {
    let copies = 0, bytes = 0;
    try {
      for (const name of await fs.promises.readdir(audioLiteDir)) {
        if (!/\.(webm|mp3)$/.test(name)) continue;
        copies++; bytes += (await fs.promises.stat(path.join(audioLiteDir, name))).size;
      }
    } catch {}
    return { copies, bytes };
  }

  const safe = async fn => { try { return await fn(); } catch { return { error: 'unavailable' }; } };

  async function snapshot() {
    const [t, c, s, d, l, b] = await Promise.all([
      safe(transcription), safe(collections), safe(sprites),
      safe(async () => ({ ...(await dataSaver()), ...(await liteUsage()) })), safe(libraryScan), safe(backup),
    ]);
    return { transcription: t, collections: c, sprites: s, dataSaver: d, libraryScan: l, backup: b };
  }

  return { snapshot };
};
