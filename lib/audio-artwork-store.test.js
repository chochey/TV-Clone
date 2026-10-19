const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createAudioArtworkStore = require('./audio-artwork-store');

const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
const book = '/mnt/media/Audio Books/Book.m4b';
const stat = (size = 1000, mtimeMs = 1700000000000.4) => ({ size, mtimeMs });
const tempDir = () => fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'artwork-'));

test('a saved cover is read back for the same file version and survives a new store (restart)', async () => {
  const dir = tempDir();
  const store = createAudioArtworkStore({ dir });
  assert.equal(store.status(book, stat()), null);
  await store.save(book, stat(), jpeg);
  assert.equal(store.status(book, stat()), 'jpg');
  assert.deepEqual(await store.read(book, stat()), jpeg);
  const restarted = createAudioArtworkStore({ dir });
  assert.equal(restarted.coverVersion(book, stat()), store.versionOf(stat()));
  assert.deepEqual(await restarted.read(book, stat()), jpeg);
});

test('a changed file (size or modification time) is unknown again, and saving replaces the old copy', async () => {
  const dir = tempDir();
  const store = createAudioArtworkStore({ dir });
  await store.save(book, stat(), jpeg);
  assert.equal(store.status(book, stat(1001)), null);
  assert.equal(store.status(book, stat(1000, 1700000999999)), null);
  assert.equal(await store.read(book, stat(1001)), null);
  await store.save(book, stat(1001), jpeg);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(store.status(book, stat(1001)), 'jpg');
});

test('a book without a cover is remembered as none, and the version string carries no inode or path', async () => {
  const dir = tempDir();
  const store = createAudioArtworkStore({ dir });
  const before = store.revision;
  await store.save(book, stat(), null);
  assert.equal(store.status(book, stat()), 'none');
  assert.equal(store.coverVersion(book, stat()), null);
  assert.equal(await store.read(book, stat()), null);
  assert.ok(store.revision > before);
  assert.match(store.versionOf(stat()), /^[a-z0-9]+-[a-z0-9]+$/);
  assert.ok(fs.readdirSync(dir).every(name => !name.includes('Book')));
});

test('prune drops covers for books no longer in the library', async () => {
  const dir = tempDir();
  const store = createAudioArtworkStore({ dir });
  const other = '/mnt/media/Audio Books/Other.m4b';
  await store.save(book, stat(), jpeg);
  await store.save(other, stat(), null);
  await store.prune([book]);
  assert.equal(store.status(book, stat()), 'jpg');
  assert.equal(store.status(other, stat()), null);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('warm loads unknown books one at a time and skips the ones already known', async () => {
  const dir = tempDir();
  const store = createAudioArtworkStore({ dir });
  await store.save(book, stat(), jpeg);
  const loaded = []; let active = 0, most = 0;
  const books = [{ filePath: book, ...stat() }, { filePath: '/b/2.m4b', ...stat() }, { filePath: '/b/3.m4b', ...stat() }];
  await store.warm(books, async filePath => {
    active++; most = Math.max(most, active); loaded.push(filePath);
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.save(filePath, stat(), jpeg); active--;
  });
  assert.deepEqual(loaded, ['/b/2.m4b', '/b/3.m4b']);
  assert.equal(most, 1);
});

test('a warm request during a running warm runs again afterwards instead of in parallel', async () => {
  const dir = tempDir();
  const store = createAudioArtworkStore({ dir });
  const seen = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = store.warm([{ filePath: '/b/1.m4b', ...stat() }], async filePath => { seen.push(filePath); await gate; await store.save(filePath, stat(), null); });
  const second = store.warm([{ filePath: '/b/1.m4b', ...stat() }, { filePath: '/b/2.m4b', ...stat() }], async filePath => { seen.push(filePath); await store.save(filePath, stat(), null); });
  release(); await Promise.all([first, second]);
  assert.deepEqual(seen, ['/b/1.m4b', '/b/2.m4b']);
});

test('a failed load is skipped without stopping the rest', async () => {
  const dir = tempDir();
  const store = createAudioArtworkStore({ dir });
  const seen = [];
  await store.warm([{ filePath: '/b/1.m4b', ...stat() }, { filePath: '/b/2.m4b', ...stat() }], async filePath => {
    seen.push(filePath); if (filePath === '/b/1.m4b') throw new Error('busy');
  });
  assert.deepEqual(seen, ['/b/1.m4b', '/b/2.m4b']);
});
