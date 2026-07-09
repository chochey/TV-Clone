// Run: node --test lib/duplicates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findDuplicates, resFromFilename } = require('./duplicates.js');
const { projectDaysLeft, branchesFromFstab } = require('./storage-health.js');

test('resFromFilename picks up release resolutions', () => {
  assert.equal(resFromFilename('Dune.2021.1080p.BluRay.mkv'), '1080p');
  assert.equal(resFromFilename('Dune 4K HDR.mkv'), '2160p');
  assert.equal(resFromFilename('Dune.mkv'), null);
});

test('findDuplicates: movies match on imdbID first', () => {
  const groups = findDuplicates([
    { id: 'a', type: 'movie', title: 'Dune', year: '2021', imdbID: 'tt1160419', fileSize: 5e9, filename: 'Dune.1080p.mkv' },
    { id: 'b', type: 'movie', title: 'Dune Part One', year: '2021', imdbID: 'tt1160419', fileSize: 2e9, filename: 'Dune.720p.mkv' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].copies.length, 2);
  assert.equal(groups[0].copies[0].id, 'a');          // largest first
  assert.equal(groups[0].copies[0].largest, true);
  assert.equal(groups[0].wasted, 2e9);                // all but largest
});

test('findDuplicates: falls back to normalized title+year', () => {
  const groups = findDuplicates([
    { id: 'a', type: 'movie', title: 'The Terminator', year: '1984', fileSize: 3e9, filename: 'a.mkv' },
    { id: 'b', type: 'movie', title: 'the terminator!', year: '1984', fileSize: 1e9, filename: 'b.mkv' },
    { id: 'c', type: 'movie', title: 'The Terminator', year: '1991', fileSize: 1e9, filename: 'c.mkv' }, // different year
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].copies.length, 2);
});

test('findDuplicates: episodes group by show+season+episode', () => {
  const groups = findDuplicates([
    { id: 'e1', type: 'show', showName: 'Firefly (2002)', epInfo: { season: 1, episode: 1 }, fileSize: 2e9, filename: 'p1.mkv' },
    { id: 'e2', type: 'show', showName: 'Firefly (2002)', epInfo: { season: 1, episode: 1 }, fileSize: 1e9, filename: 'p1-2.mkv' },
    { id: 'e3', type: 'show', showName: 'Firefly (2002)', epInfo: { season: 1, episode: 2 }, fileSize: 1e9, filename: 'p2.mkv' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Firefly (2002) — S01E01');
});

test('findDuplicates: folder season overrides a lying filename', () => {
  // Real-world failure: six season folders whose files are ALL named S01Exx.
  // The folder is the truth — these are different episodes, not duplicates.
  const groups = findDuplicates([
    { id: 'a', type: 'show', showName: 'Snowfall (2017)', epInfo: { season: 1, episode: 1 }, relDir: 'Snowfall (2017)/Season 01/Season 1', fileSize: 2e9, filename: 'Snowfall - S01E01 - Pilot.mkv' },
    { id: 'b', type: 'show', showName: 'Snowfall (2017)', epInfo: { season: 1, episode: 1 }, relDir: 'Snowfall (2017)/Season 01/Season 2', fileSize: 2e9, filename: 'Snowfall - S01E01 - Pilot.mkv' },
  ]);
  assert.equal(groups.length, 0);
  // ...but true same-folder copies still group.
  const real = findDuplicates([
    { id: 'a', type: 'show', showName: 'X', epInfo: { season: 1, episode: 1 }, relDir: 'X/Season 1', fileSize: 2e9, filename: 'p.mkv' },
    { id: 'b', type: 'show', showName: 'X', epInfo: { season: 1, episode: 1 }, relDir: 'X/Season 1', fileSize: 1e9, filename: 'p-2.mkv' },
  ]);
  assert.equal(real.length, 1);
});

test('findDuplicates: unidentifiable items are never grouped', () => {
  const groups = findDuplicates([
    { id: 'x', type: 'show', showName: 'Firefly', epInfo: null, fileSize: 1e9, filename: 'x.mkv' },
    { id: 'y', type: 'show', showName: 'Firefly', epInfo: null, fileSize: 1e9, filename: 'y.mkv' },
  ]);
  assert.equal(groups.length, 0);
});

test('projectDaysLeft: linear fill rate', () => {
  const day = 86400000;
  const hist = [
    { ts: 0, used: 100 },
    { ts: 10 * day, used: 200 }, // 10/day
  ];
  const p = projectDaysLeft(hist, 500);
  assert.equal(p.daysLeft, 50);
});

test('projectDaysLeft: flat or shrinking usage gives no ETA', () => {
  const day = 86400000;
  assert.equal(projectDaysLeft([{ ts: 0, used: 200 }, { ts: 5 * day, used: 100 }], 500), null);
  assert.equal(projectDaysLeft([{ ts: 0, used: 100 }], 500), null);
});

test('branchesFromFstab parses the mergerfs line with escaped spaces', () => {
  const fstab = [
    '# comment',
    'UUID=abc / ext4 defaults 0 1',
    '/media/blue/Drive\\040One:/media/blue/Two /mnt/media mergerfs defaults 0 0',
  ].join('\n');
  assert.deepEqual(branchesFromFstab(fstab), ['/media/blue/Drive One', '/media/blue/Two']);
});
