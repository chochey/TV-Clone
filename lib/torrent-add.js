// Compare torrent identities, never release names or remotely fetched pages.
function magnetHashes(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!/^magnet:\?/i.test(value)) return [];
  const hashes = new Set();
  for (const identifier of new URLSearchParams(value.slice(value.indexOf('?') + 1)).getAll('xt')) {
    let match = identifier.match(/^urn:btih:([a-f0-9]{40})$/i);
    if (match) { hashes.add(`v1:${match[1].toLowerCase()}`); continue; }
    match = identifier.match(/^urn:btih:([a-z2-7]{32})$/i);
    if (match) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = 0, buffer = 0;
      const bytes = [];
      for (const char of match[1].toUpperCase()) {
        buffer = (buffer << 5) | alphabet.indexOf(char);
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
      }
      hashes.add(`v1:${Buffer.from(bytes).toString('hex')}`);
      continue;
    }
    match = identifier.match(/^urn:btmh:1220([a-f0-9]{64})$/i);
    if (match) hashes.add(`v2:${match[1].toLowerCase()}`);
  }
  return [...hashes];
}

function torrentHashes(torrent) {
  const hashes = new Set(magnetHashes(torrent.magnet_uri));
  if (/^[a-f0-9]{40}$/i.test(torrent.infohash_v1 || '')) hashes.add(`v1:${torrent.infohash_v1.toLowerCase()}`);
  if (/^[a-f0-9]{64}$/i.test(torrent.infohash_v2 || '')) hashes.add(`v2:${torrent.infohash_v2.toLowerCase()}`);
  // A v2 torrent may expose a truncated 40-character routing hash. Never
  // mistake that prefix for a v1 identity when the full identity is known.
  if (!hashes.size && /^[a-f0-9]{40}$/i.test(torrent.hash || '')) hashes.add(`v1:${torrent.hash.toLowerCase()}`);
  if (/^[a-f0-9]{64}$/i.test(torrent.hash || '')) hashes.add(`v2:${torrent.hash.toLowerCase()}`);
  return [...hashes];
}

function splitTorrentAdds(urls, torrents) {
  if (!Array.isArray(torrents) || torrents.some(t => !t || typeof t !== 'object' || Array.isArray(t))) {
    throw new Error('Downloader returned an invalid torrent list.');
  }
  const known = new Map();
  torrents.forEach((torrent, index) => {
    for (const hash of torrentHashes(torrent)) known.set(hash, index);
  });
  const existingIndexes = new Set(), newUrls = [];
  for (const url of urls) {
    const indexes = magnetHashes(url).filter(hash => known.has(hash)).map(hash => known.get(hash));
    if (indexes.length) indexes.forEach(index => existingIndexes.add(index));
    else newUrls.push(url);
  }
  return { newUrls, existingIndexes: [...existingIndexes] };
}

function duplicateAddResult(rows, addedCount = 0) {
  const imported = addedCount === 0 && rows.every(row => row.importStatus?.readyToHide === true);
  const name = rows.length === 1 && typeof rows[0].name === 'string' ? rows[0].name : '';
  let message;
  if (addedCount) message = `Sent ${addedCount} new download${addedCount === 1 ? '' : 's'} to the downloader; ${rows.length} already present.`;
  else if (rows.length === 1) message = imported ? 'Already imported into your library.' : 'Already in the downloader. Check its current status below.';
  else message = imported ? `All ${rows.length} downloads are already imported into your library.` : `These ${rows.length} downloads are already in the downloader. Check their current status below.`;
  return { ok: true, alreadyExists: true, imported, name, message, addedCount, existingCount: rows.length };
}

module.exports = { magnetHashes, splitTorrentAdds, duplicateAddResult };
