// What the server is busy with in the background, for the dashboard: audiobook
// transcription (tools/readalong/transcript, run outside the server; read from
// its work folder), the nightly collections lookup, seek-bar thumbnails, Data
// Saver copies, library scans, the nightly backup and the weekly container
// update. Each source is reported on its own, so one that fails never hides
// the rest.
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
    const underPool = dir => !!dir && poolRoots.some(root => dir === root || dir.startsWith(root.replace(/\/$/, '') + '/'));
    const onPool = underPool(where);
    // The encrypted copy (lib/backup-encrypted-copy.js) is what normally lives on the pool.
    const copy = r.copy ? { ok: !!r.copy.ok, onPool: underPool(r.copy.dir), error: r.copy.error || null, bytes: r.copy.bytes || 0, kept: r.copy.kept || 0 } : null;
    return { at, ok: !!r.ok, verified: !!r.verified, error: r.error || null, where, fileCount: r.fileCount || 0, bytes: r.bytes || 0,
      kept: r.kept || 0, onPool, ageHours, stale: ageHours > 36, copy,
      offDisk: !!r.ok && (onPool || !!(copy && copy.ok && copy.onPool)) };
  }
  // The weekly container update's result (scripts/update-containers.js, run as blue, who can use
  // Docker; the app cannot). Late after 8 days without a report; an image built 90+ days ago is old.
  async function containers() {
    if (!dataDir) return { missing: true };
    let r;
    try { r = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'container-updates.json'), 'utf8')); } catch { return { missing: true }; }
    const at = Date.parse(r.at) || 0;
    const hoursAgo = Math.round((now() - at) / 3600000);
    return { at, ok: !!r.ok, result: r.result || 'unknown', reason: r.reason || '', error: r.error || null, hoursAgo, late: hoursAgo > 8 * 24,
      containers: (r.containers || []).map(c => {
        const builtAt = Date.parse(c.builtAt) || 0;
        const ageDays = builtAt ? Math.floor((now() - builtAt) / 86400000) : null;
        return { name: c.name, image: c.image, builtAt, ageDays, old: ageDays !== null && ageDays >= 90, updated: !!c.updated,
          rolledBack: !!c.rolledBack, previousBuiltAt: Date.parse(c.previousBuiltAt) || null, healthy: !!c.healthy, error: c.error || null };
      }) };
  }
  // The nightly SnapRAID job's receipt (scripts/snapraid/snapraid-nightly.sh); late after 48 h without one.
  async function snapraid() {
    if (!dataDir) return { missing: true };
    let r;
    try { r = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'snapraid-receipt.json'), 'utf8')); } catch { return { missing: true }; }
    const at = Number(r.at) || 0;
    const hoursAgo = Math.round((now() - at) / 3600000);
    // 'syncing' is written when a sync starts (the first one runs a day or more); it is never late.
    return { at, ok: !!r.ok, result: r.result || 'unknown', error: r.error || null, deleted: r.deleted || 0, scrubbed: !!r.scrubbed,
      seconds: r.seconds || 0, hoursAgo, late: hoursAgo > 48 && r.result !== 'syncing' };
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
    const [t, c, s, d, l, b, k, r] = await Promise.all([
      safe(transcription), safe(collections), safe(sprites),
      safe(async () => ({ ...(await dataSaver()), ...(await liteUsage()) })), safe(libraryScan), safe(backup), safe(containers), safe(snapraid),
    ]);
    return { transcription: t, collections: c, sprites: s, dataSaver: d, libraryScan: l, backup: b, containers: k, snapraid: r };
  }

  return { snapshot };
};
