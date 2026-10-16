const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { classifyLeftovers, onlyOtherFiles } = require('./organizer-share');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'organizer-share-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'Share');
  const folder = path.join(sourceDir, 'Imported release');
  const target = path.join(root, 'Movies', 'Film.mp4');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, 'movie');
  await fs.writeFile(path.join(folder, 'www.example.jpg'), 'image');
  await fs.writeFile(path.join(folder, 'download.txt'), 'advert');
  return { folder, target, entries: [{ name: 'Imported release', mtime: 1 }], options: {
    sourceDir, libraryPaths: [target], lines: [
      `[2026-10-03 00:00:00] Import source: ${path.join(folder, 'source.mp4')} -> ${target}`,
      `[2026-10-03 00:00:00] Moved -> ${target}`,
    ],
  } };
}

test('imported advertising leftovers do not count as stuck media', async t => {
  const f = await fixture(t);
  const result = await classifyLeftovers(f.entries, f.options);
  assert.equal(result.leftovers.length, 0);
  assert.equal(result.importedLeftovers.length, 1);
  assert.equal((await fs.readdir(f.folder)).length, 2, 'classification never deletes files');
});

test('remaining video, subtitle or unknown content stays in review', async t => {
  const f = await fixture(t);
  for (const name of ['extra.mkv', 'English.srt', 'unknown.bin']) {
    const file = path.join(f.folder, name);
    await fs.writeFile(file, 'keep');
    assert.equal((await classifyLeftovers(f.entries, f.options)).leftovers.length, 1);
    await fs.unlink(file);
  }
});

test('failed import, missing library item or missing physical copy cannot be marked imported', async t => {
  const f = await fixture(t);
  assert.equal((await classifyLeftovers(f.entries, { ...f.options, lines: f.options.lines.slice(0, 1) })).leftovers.length, 1);
  assert.equal((await classifyLeftovers(f.entries, { ...f.options, libraryPaths: [] })).leftovers.length, 1);
  await fs.unlink(f.target);
  assert.equal((await classifyLeftovers(f.entries, f.options)).leftovers.length, 1);
});

test('symlinks and unreadable folders stay in review without following links', async t => {
  const f = await fixture(t);
  await fs.symlink(f.target, path.join(f.folder, 'advert.jpg'));
  assert.equal(await onlyOtherFiles(f.folder), false);
  assert.equal(await onlyOtherFiles(f.folder, { lstat: async () => { throw new Error('EIO'); } }), false);
});

test('a release is recognised from the typed event alone', async t => {
  const f = await fixture(t);
  const lines = [`[2026-10-16 09:00:00] EVENT: ${JSON.stringify({ event: 'moved', release: 'Imported release',
    source: path.join(f.folder, 'source.mp4'), destination: f.target })}`];
  const result = await classifyLeftovers(f.entries, { ...f.options, lines });
  assert.equal(result.importedLeftovers.length, 1);
  assert.equal(result.leftovers.length, 0);
});

test('the same move written both ways is still one imported release', async t => {
  const f = await fixture(t);
  const lines = [...f.options.lines, `[2026-10-16 09:00:00] EVENT: ${JSON.stringify({ event: 'moved', release: 'Imported release',
    source: path.join(f.folder, 'source.mp4'), destination: f.target })}`];
  const result = await classifyLeftovers(f.entries, { ...f.options, lines });
  assert.equal(result.importedLeftovers.length, 1);
});

test('a file filed from a lookalike folder beside the download folder does not mark a release imported', async t => {
  const f = await fixture(t);
  // "Share-old/Imported release/..." starts with the text of the download folder's path but is not inside it.
  const outside = `${f.options.sourceDir}-old/Imported release/source.mp4`;
  const lines = [`EVENT: ${JSON.stringify({ event: 'moved', release: 'Imported release', source: outside, destination: f.target })}`];
  assert.equal((await classifyLeftovers(f.entries, { ...f.options, lines })).leftovers.length, 1);
  assert.equal((await classifyLeftovers(f.entries, { ...f.options, lines })).importedLeftovers.length, 0);
});

test('an event for a file that is not in the library is not enough', async t => {
  const f = await fixture(t);
  const lines = [`EVENT: ${JSON.stringify({ event: 'moved', release: 'Imported release', source: path.join(f.folder, 'source.mp4'), destination: f.target })}`];
  assert.equal((await classifyLeftovers(f.entries, { ...f.options, lines, libraryPaths: [] })).leftovers.length, 1);
});
