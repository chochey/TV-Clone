// Pure-logic tests for the notification decision functions.
// Run: cd v2/frontend && node --test src/lib/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { torrentStates, diffDownloads, cleanTorrentName } from './notifications.js';
import { groupNewContent } from './stores.js';

test('cleanTorrentName strips a trailing video extension', () => {
  assert.equal(cleanTorrentName('The Bear S03E01.mkv'), 'The Bear S03E01');
  assert.equal(cleanTorrentName('folder name'), 'folder name');
});

test('diffDownloads: baseline poll announces nothing', () => {
  const now = torrentStates([{ hash: 'a', progress: 0.2, state: 'downloading', name: 'X.mkv' }]);
  assert.deepEqual(diffDownloads(null, now), []);
});

test('diffDownloads: a new in-progress torrent fires "started"', () => {
  const prev = torrentStates([]);
  const now = torrentStates([{ hash: 'a', progress: 0.1, state: 'downloading', name: 'Dune.mkv' }]);
  const out = diffDownloads(prev, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'download');
  assert.equal(out[0].body, 'Dune');
});

test('diffDownloads: a torrent that reaches 100% fires "complete" once', () => {
  const prev = torrentStates([{ hash: 'a', progress: 0.9, state: 'downloading', name: 'Dune.mkv' }]);
  const now = torrentStates([{ hash: 'a', progress: 1, state: 'uploading', name: 'Dune.mkv' }]);
  const out = diffDownloads(prev, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'complete');
  // and it does not re-fire on the next identical poll
  assert.deepEqual(diffDownloads(now, torrentStates([{ hash: 'a', progress: 1, state: 'uploading', name: 'Dune.mkv' }])), []);
});

test('diffDownloads: an already-complete torrent appearing does not spam', () => {
  const prev = torrentStates([]);
  const now = torrentStates([{ hash: 'a', progress: 1, state: 'pausedUP', name: 'Old.mkv' }]);
  // new hash but already done → neither started nor completed
  assert.deepEqual(diffDownloads(prev, now), []);
});

test('groupNewContent: episodes collapse to one per show with a count', () => {
  const specs = groupNewContent([
    { id: 'e1', type: 'show', showName: 'The Bear (2022)' },
    { id: 'e2', type: 'show', showName: 'The Bear (2022)' },
    { id: 'e3', type: 'show', showName: 'The Bear (2022)' },
  ]);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].title, 'The Bear');
  assert.equal(specs[0].body, '3 new episodes added');
  assert.equal(specs[0].itemId, 'e1');
});

test('groupNewContent: single episode reads singular', () => {
  const specs = groupNewContent([{ id: 'e1', type: 'show', showName: 'Severance' }]);
  assert.equal(specs[0].body, 'New episode added');
});

test('groupNewContent: each film gets its own notification', () => {
  assert.equal(groupNewContent([{ id: 'm1', type: 'movie', title: 'Dune' }])[0].title, 'Dune');
  const many = groupNewContent([
    { id: 'm1', type: 'movie', title: 'A' },
    { id: 'm2', type: 'movie', title: 'B' },
  ]);
  assert.equal(many.length, 2);
  assert.equal(many[0].title, 'A');
  assert.equal(many[1].title, 'B');
});

test('groupNewContent: mixed shows + films', () => {
  const specs = groupNewContent([
    { id: 'e1', type: 'show', showName: 'The Bear' },
    { id: 'm1', type: 'movie', title: 'Dune' },
  ]);
  assert.equal(specs.length, 2);
});

test('groupNewContent: empty in, empty out', () => {
  assert.deepEqual(groupNewContent([]), []);
});
