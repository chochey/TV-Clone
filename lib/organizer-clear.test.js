const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { clearJunk } = require('./organizer-clear');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'organizer-clear-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'Share');
  await fs.mkdir(sourceDir);
  const put = async (relative, text = 'x') => {
    const file = path.join(sourceDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  const exists = async file => fs.lstat(file).then(() => true, () => false);
  return { root, sourceDir, put, exists, at: relative => path.join(sourceDir, relative) };
}

test('a folder holding only leftover files is removed, with its sub-folders', async t => {
  const f = await fixture(t);
  await f.put('Release/RARBG.txt');
  await f.put('Release/info.nfo');
  await f.put('Release/Screens/one.jpg');
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Release'] });
  assert.deepEqual(result, { cleared: [{ name: 'Release', files: 3, folderRemoved: true }], skipped: [] });
  assert.equal(await f.exists(f.at('Release')), false);
  assert.equal(await f.exists(f.sourceDir), true, 'the download folder itself is never touched');
});

test('a loose leftover file in the download folder is removed too', async t => {
  const f = await fixture(t);
  await f.put('advert.url');
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['advert.url'] });
  assert.deepEqual(result.cleared, [{ name: 'advert.url', files: 1, folderRemoved: true }]);
});

test('anything that is not a leftover file stops the whole folder from being touched', async t => {
  const f = await fixture(t);
  for (const keep of ['episode.mkv', 'subs.srt', 'archive.rar', 'noextension', 'Deep/er/clip.mp4']) {
    await f.put('Release/RARBG.txt');
    await f.put(`Release/${keep}`);
    const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Release'] });
    assert.equal(result.cleared.length, 0, keep);
    assert.match(result.skipped[0].reason, /something other than leftover files/, keep);
    assert.equal(await f.exists(f.at('Release/RARBG.txt')), true, `${keep}: the leftover files stay too`);
    assert.equal(await f.exists(f.at(`Release/${keep}`)), true, keep);
    await fs.rm(f.at('Release'), { recursive: true });
  }
});

test('only plain names inside the download folder are accepted', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'keep');
  await f.put('_review/note.txt');
  await f.put('incomplete/part.txt');
  await f.put('.hidden/a.txt');
  const bad = ['../outside.txt', '..', '.', '', 'a/b', 'a\\b', '_review', 'incomplete', 'INCOMPLETE', '.hidden', 'x\0y', 'x'.repeat(300), 42, null, {}];
  const result = await clearJunk({ sourceDir: f.sourceDir, names: bad });
  assert.equal(result.cleared.length, 0);
  assert.equal(result.skipped.length, bad.length);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  for (const kept of ['_review/note.txt', 'incomplete/part.txt', '.hidden/a.txt']) assert.equal(await f.exists(f.at(kept)), true, kept);
});

test('a link is never followed or removed', async t => {
  const f = await fixture(t);
  const secret = path.join(f.root, 'secret');
  await fs.mkdir(secret);
  await fs.writeFile(path.join(secret, 'keep.txt'), 'keep');
  await fs.symlink(secret, f.at('Linked'));
  await f.put('Plain/a.txt');
  await fs.symlink(path.join(secret, 'keep.txt'), f.at('Plain/b.txt'));
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Linked', 'Plain'] });
  assert.equal(result.cleared.length, 0);
  assert.equal(await fs.readFile(path.join(secret, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await f.exists(f.at('Linked')), true);
  assert.equal(await f.exists(f.at('Plain/a.txt')), true, 'a folder containing a link is left whole');
});

test('a file replaced between the scan and the removal is not removed', async t => {
  const f = await fixture(t);
  const first = await f.put('Release/first.txt');
  const second = await f.put('Release/second.txt');
  const outside = path.join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'keep');
  let swapped = null;
  const io = {
    ...fs,
    unlink: async file => {
      await fs.unlink(file);
      if (!swapped) {
        // Whichever file went first, a racing process now swaps the other for a link to somewhere else.
        swapped = file === first ? second : first;
        await fs.unlink(swapped);
        await fs.symlink(outside, swapped);
      }
    },
  };
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Release'], io });
  assert.equal(result.cleared.length, 0);
  assert.match(result.skipped[0].reason, /changed while it was being cleared/);
  assert.equal(result.skipped[0].removed, 1, 'what was already removed is reported');
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  assert.equal((await fs.lstat(swapped)).isSymbolicLink(), true, 'the swapped-in link is left alone');
});

test('something new appearing in the folder keeps the folder', async t => {
  const f = await fixture(t);
  await f.put('Release/a.txt');
  await f.put('Release/Sub/b.txt');
  let added = false;
  const io = {
    ...fs,
    unlink: async file => {
      await fs.unlink(file);
      if (!added) { added = true; await fs.writeFile(f.at('Release/Sub/arrived.mkv'), 'new'); }
    },
  };
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Release'], io });
  assert.deepEqual(result.cleared, [{ name: 'Release', files: 2, folderRemoved: false }]);
  assert.equal(await f.exists(f.at('Release/Sub/arrived.mkv')), true, 'media that arrived is untouched');
  assert.equal(await f.exists(f.at('Release/a.txt')), false);
});

test('a removal that fails is reported and the rest of the batch carries on', async t => {
  const f = await fixture(t);
  await f.put('Locked/a.txt');
  await f.put('Fine/a.txt');
  const io = {
    ...fs,
    unlink: async file => {
      if (file.includes('Locked')) throw Object.assign(new Error('read-only'), { code: 'EACCES' });
      return fs.unlink(file);
    },
  };
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Locked', 'Fine'], io });
  assert.deepEqual(result.cleared.map(c => c.name), ['Fine']);
  assert.equal(result.skipped[0].name, 'Locked');
  assert.match(result.skipped[0].reason, /could not be removed/);
  assert.equal(await f.exists(f.at('Locked/a.txt')), true);
});

test('names are de-duplicated and a file that vanished meanwhile is not an error', async t => {
  const f = await fixture(t);
  await f.put('Release/a.txt');
  await f.put('Release/b.txt');
  const io = { ...fs, unlink: async file => { if (file.endsWith('a.txt')) { await fs.unlink(file); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } return fs.unlink(file); } };
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Release', 'Release'], io });
  assert.equal(result.cleared.length, 1);
  assert.equal(result.skipped.length, 0);
});

test('a missing name is reported, not thrown', async t => {
  const f = await fixture(t);
  const result = await clearJunk({ sourceDir: f.sourceDir, names: ['Never existed'] });
  assert.equal(result.cleared.length, 0);
  assert.equal(result.skipped[0].reason, 'It is no longer in the download folder.');
});

test('bad requests are rejected with a status the endpoint can return', async t => {
  const f = await fixture(t);
  for (const names of [undefined, [], 'Release', Array.from({ length: 201 }, (_, i) => `r${i}`)]) {
    await assert.rejects(clearJunk({ sourceDir: f.sourceDir, names }), error => error.status === 400);
  }
  await assert.rejects(clearJunk({ sourceDir: path.join(f.root, 'missing'), names: ['x'] }), error => error.status === 503);
  await fs.symlink(f.sourceDir, path.join(f.root, 'LinkedShare'));
  await assert.rejects(clearJunk({ sourceDir: path.join(f.root, 'LinkedShare'), names: ['x'] }), error => error.status === 503);
});
