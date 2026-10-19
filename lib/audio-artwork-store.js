// Embedded audiobook covers, saved to disk once. Without this every restart
// meant pulling each cover out of its book again (ffprobe + ffmpeg on the pool)
// before the shelf could show it. Entries are keyed by a hash of the book's path
// plus its size and modification time -- never device/inode, which mergerfs
// renumbers on every mount. A ".none" entry remembers a book has no cover.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENTRY = /^([a-f0-9]{20})-([a-z0-9]+-[a-z0-9]+)\.(jpg|none)$/;

module.exports = function createAudioArtworkStore({ dir, io = fs }) {
  const known = new Map(); // path hash -> { version, kind: 'jpg' | 'none' }
  let loaded = false, revision = 0, running = null, next = null;

  const hashOf = filePath => crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 20);
  const versionOf = ({ size, mtimeMs }) => `${Math.max(0, Number(size) || 0).toString(36)}-${Math.max(0, Math.round(Number(mtimeMs) || 0)).toString(36)}`;
  const fileName = (hash, entry) => path.join(dir, `${hash}-${entry.version}.${entry.kind}`);

  function load() {
    if (loaded) return;
    loaded = true;
    let names = [];
    try { names = io.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const match = ENTRY.exec(name);
      if (match) known.set(match[1], { version: match[2], kind: match[3] });
    }
  }

  // 'jpg', 'none', or null when this version of the book hasn't been looked at.
  function status(filePath, stat) {
    load();
    const entry = known.get(hashOf(filePath));
    return entry && entry.version === versionOf(stat) ? entry.kind : null;
  }
  const coverVersion = (filePath, stat) => (status(filePath, stat) === 'jpg' ? versionOf(stat) : null);

  async function read(filePath, stat) {
    if (status(filePath, stat) !== 'jpg') return null;
    try { return await io.promises.readFile(fileName(hashOf(filePath), { version: versionOf(stat), kind: 'jpg' })); }
    catch { return null; }
  }

  async function save(filePath, stat, image) {
    load();
    const hash = hashOf(filePath), entry = { version: versionOf(stat), kind: image ? 'jpg' : 'none' };
    const previous = known.get(hash), target = fileName(hash, entry);
    await io.promises.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
    await io.promises.writeFile(temp, image || '');
    await io.promises.rename(temp, target);
    if (previous && (previous.version !== entry.version || previous.kind !== entry.kind)) {
      await io.promises.rm(fileName(hash, previous), { force: true });
    }
    known.set(hash, entry);
    revision++;
  }

  async function prune(filePaths) {
    load();
    const keep = new Set(filePaths.map(hashOf));
    for (const [hash, entry] of [...known]) {
      if (keep.has(hash)) continue;
      await io.promises.rm(fileName(hash, entry), { force: true });
      known.delete(hash);
      revision++;
    }
  }

  // One book at a time, in the background. A call while a pass is running
  // queues one more pass with the newest list instead of running in parallel.
  function warm(books, loadBook) {
    next = { books, loadBook };
    running ||= (async () => {
      while (next) {
        const job = next; next = null;
        for (const book of job.books) {
          if (status(book.filePath, book) !== null) continue;
          try { await job.loadBook(book.filePath); } catch { /* left unknown; the next scan tries again */ }
        }
      }
      running = null;
    })();
    return running;
  }

  return { status, coverVersion, versionOf, read, save, prune, warm, get revision() { return revision; } };
};
