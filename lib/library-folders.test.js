const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateFolderPath, normalizeFolder, publicSections, sectionId, overlapsFolder } = require('./library-folders');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('folder validation canonicalizes existing directories and rejects files, missing and nonabsolute paths', t => {
  const root = fixture(t), media = path.join(root, 'Media'); fs.mkdirSync(media);
  assert.equal(validateFolderPath(path.join(media, '..', 'Media')), media);
  fs.writeFileSync(path.join(root, 'file.mp3'), 'fixture');
  for (const candidate of ['relative/Media', '', null, ['/tmp'], '/', '/etc', '/run', '/var/lib', '/tmp\0bad']) {
    assert.throws(() => validateFolderPath(candidate));
  }
  assert.throws(() => validateFolderPath(path.join(root, 'file.mp3')), /not a directory/);
  assert.throws(() => validateFolderPath(path.join(root, 'missing')), /not a directory/);
});

test('a symlink cannot bypass sensitive/private directory restrictions', t => {
  const root = fixture(t), privateDir = path.join(root, 'private'); fs.mkdirSync(privateDir);
  const alias = path.join(root, 'Media'); fs.symlinkSync(privateDir, alias);
  assert.throws(() => validateFolderPath(alias, { privatePaths: [privateDir] }), error => error.status === 403);
  fs.unlinkSync(alias); fs.symlinkSync('/etc', alias);
  assert.throws(() => validateFolderPath(alias), error => error.status === 403);
});

test('custom labels/slugs and explicit media kinds are persisted independently', t => {
  const root = fixture(t);
  const folder = normalizeFolder({ path: root, label: 'Anime', type: 'custom-anime', mediaKind: 'mixed' });
  assert.equal(folder.type, 'custom-anime'); assert.equal(folder.mediaKind, 'mixed');
  assert.equal(folder.label, 'Anime'); assert.equal(folder.path, root);
  assert.throws(() => normalizeFolder({ path: root, type: '../bad' }), /Section type/);
  assert.throws(() => normalizeFolder({ path: root, mediaKind: 'video' }), /media kind/);
  assert.throws(() => normalizeFolder({ path: root, label: 'Bad\nLabel' }), /Section name/);
});

test('public section summaries include empty legacy locations without revealing paths', () => {
  const folders = [{ path: '/media/Movies', type: 'movie', label: 'Movies' },
    { path: '/media/Podcasts', type: 'custom-podcasts', label: 'Podcasts', mediaKind: 'audio' }];
  const sections = publicSections(folders, [{ folderPath: '/media/Movies' }]);
  assert.equal(sections[0].count, 1); assert.equal(sections[1].count, 0);
  assert.equal(sections[1].mediaKind, 'audio');
  assert.equal(sections[1].id, sectionId('/media/Podcasts'));
  assert.ok(!JSON.stringify(sections).includes('/media/'));
  assert.ok(!('path' in sections[1]));
});

test('linking rejects ancestors of private state while directory browsing may navigate them', t => {
  const root = fixture(t), privateDir = path.join(root, 'private'); fs.mkdirSync(privateDir);
  assert.throws(() => validateFolderPath(root, { privatePaths: [privateDir] }), error => error.status === 403);
  assert.equal(validateFolderPath(root, { privatePaths: [privateDir], allowPrivateAncestors: true }), root);
  assert.throws(() => validateFolderPath(privateDir, { privatePaths: [privateDir], allowPrivateAncestors: true }));
});

test('exact paths, symlink aliases, ancestors and descendants overlap existing libraries', t => {
  const root = fixture(t), media = path.join(root, 'Media'), child = path.join(media, 'Series');
  fs.mkdirSync(child, { recursive: true });
  const alias = path.join(root, 'Alias'); fs.symlinkSync(media, alias);
  const other = path.join(root, 'Other'); fs.mkdirSync(other);
  assert.equal(overlapsFolder(media, [{ path: alias }]), true);
  assert.equal(overlapsFolder(child, [{ path: media }]), true);
  assert.equal(overlapsFolder(media, [{ path: child }]), true);
  assert.equal(overlapsFolder(other, [{ path: media }]), false);
});

test('a symlink cannot smuggle a blocked location past the blocklist (sec-005)', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'folder-escape-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const bait = path.join(dir, 'looks-harmless');
  fs.symlinkSync('/etc', bait);
  // The requested path passes the blocklist on its face; only resolving it
  // reveals /etc, so the check must run again on the canonical path.
  assert.throws(() => validateFolderPath(bait), /cannot be used as a media library/);

  // A segment-aware blocklist must not over-block a legitimate sibling.
  const sibling = path.join(dir, 'etcetera');
  fs.mkdirSync(sibling);
  assert.equal(validateFolderPath(sibling), fs.realpathSync(sibling));
});
