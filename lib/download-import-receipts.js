const { canHideDownload } = require('./download-status');

function generation(torrent) {
  const addedOn = Number(torrent.added_on);
  if (typeof torrent.hash !== 'string' || !torrent.hash || torrent.hash.length > 128
      || !Number.isFinite(addedOn) || addedOn <= 0) return null;
  return JSON.stringify([torrent.hash, addedOn]);
}

// These are visibility receipts, never downloader or media-file operations.
// A later conversion or rotated log must not make a confirmed download return.
function createDownloadImportReceipts({ initial = {}, save = async () => {}, now = Date.now, limit = 512 } = {}) {
  const receipts = new Map();
  let observations = new Map(), revision = 0, dirty = false;
  for (const entry of (Array.isArray(initial?.entries) ? initial.entries : []).slice(-limit)) {
    if (!entry || typeof entry !== 'object') continue;
    const key = generation({ hash: entry.hash, added_on: entry.addedOn });
    if (key && Number.isFinite(entry.confirmedAt) && entry.confirmedAt > 0) {
      receipts.set(key, { hash: entry.hash, addedOn: Number(entry.addedOn), confirmedAt: entry.confirmedAt });
    }
  }

  async function decorate(torrents, { statusFor, confirmStatus, reviewFor = () => '', invalidateProof = confirmStatus.invalidate || (() => {}) }) {
    if (!Array.isArray(torrents)) throw new TypeError('Invalid download snapshot');
    const observation = ++revision;
    const snapshot = torrents.map(t => {
      const torrent = { ...t, reviewReason: reviewFor(t) || '' };
      return { torrent, key: generation(torrent), current: statusFor(torrent) };
    });
    observations = new Map(snapshot.filter(row => row.key).map(row => [row.key, observation]));
    const invalidated = new Set();
    for (const { torrent, key, current } of snapshot) {
      if (torrent.progress < 1 || torrent.reviewReason || current?.label === 'Needs review') {
        if (key) invalidated.add(key);
        invalidateProof(torrent);
      }
    }
    for (const key of receipts.keys()) {
      // qBittorrent can redownload the moved files without changing added_on.
      // New incomplete bytes or an explicit review invalidate the old proof.
      if (!observations.has(key) || invalidated.has(key)) { receipts.delete(key); dirty = true; }
    }
    const rows = new Array(torrents.length);
    let cursor = 0;
    async function worker() {
      while (cursor < torrents.length) {
        const index = cursor++;
        const { torrent, key, current } = snapshot[index];
        let importStatus = current;
        if (key && receipts.has(key) && canHideDownload(torrent, current)) {
          importStatus = { label: 'Imported files available',
            detail: 'All media was previously confirmed in the library. Any remaining companion files stay in Share.', readyToHide: true };
        } else if (canHideDownload(torrent, current)) {
          importStatus = await confirmStatus(torrent);
          if (key && observations.get(key) !== observation && importStatus?.readyToHide) {
            // An intervening snapshot can observe a redownload or review while
            // this filesystem proof is in flight. Its result is now obsolete.
            importStatus = { ...importStatus, readyToHide: false };
          } else if (key && importStatus?.readyToHide && !invalidated.has(key)) {
            receipts.set(key, { hash: torrent.hash, addedOn: Number(torrent.added_on), confirmedAt: now() });
            while (receipts.size > limit) receipts.delete(receipts.keys().next().value);
            dirty = true;
          }
        }
        rows[index] = { ...torrent, importStatus };
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, torrents.length) }, worker));
    if (dirty) {
      dirty = false;
      try { await save({ version: 1, entries: [...receipts.values()] }); }
      catch { dirty = true; } // Retry bookkeeping on the next successful snapshot.
    }
    return rows;
  }
  return { decorate };
}

module.exports = { createDownloadImportReceipts };
