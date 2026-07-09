// Pure-logic tests for the server-side notification history.
// Run: node --test lib/notify-log.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const notifyLogLib = require('./notify-log.js');
const { cleanTorrentName, torrentStates, diffDownloads, groupAddedContent } = notifyLogLib;

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

test('groupAddedContent: episodes collapse to one per show with a count', () => {
  const specs = groupAddedContent([
    { id: 'e1', type: 'show', showName: 'The Bear (2022)' },
    { id: 'e2', type: 'show', showName: 'The Bear (2022)' },
    { id: 'e3', type: 'show', showName: 'The Bear (2022)' },
  ]);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].title, 'The Bear');
  assert.equal(specs[0].body, '3 new episodes added');
  assert.equal(specs[0].itemId, 'e1');
});

test('groupAddedContent: single episode reads singular', () => {
  const specs = groupAddedContent([{ id: 'e1', type: 'show', showName: 'Severance' }]);
  assert.equal(specs[0].body, 'New episode added');
});

test('groupAddedContent: each film gets its own event', () => {
  assert.equal(groupAddedContent([{ id: 'm1', type: 'movie', title: 'Dune' }])[0].title, 'Dune');
  const many = groupAddedContent([
    { id: 'm1', type: 'movie', title: 'A' },
    { id: 'm2', type: 'movie', title: 'B' },
  ]);
  assert.equal(many.length, 2);
  assert.equal(many[0].title, 'A');
  assert.equal(many[1].title, 'B');
});

test('groupAddedContent: mixed shows + films, empty in empty out', () => {
  const specs = groupAddedContent([
    { id: 'e1', type: 'show', showName: 'The Bear' },
    { id: 'm1', type: 'movie', title: 'Dune' },
  ]);
  assert.equal(specs.length, 2);
  assert.deepEqual(groupAddedContent([]), []);
});

// ── Log store: push caps, ids increment, audience filtering ─────────────

function makeLog() {
  const files = {};
  return notifyLogLib({
    DATA_DIR: '/tmp',
    loadJSON: () => [],
    saveJSON: (f, v) => { files[f] = v; },
    maxEvents: 3,
  });
}

test('log: push assigns increasing ids and caps the list', () => {
  const log = makeLog();
  for (let i = 0; i < 5; i++) log.push({ type: 'added', title: `t${i}` });
  const all = log.list({ role: 'admin' });
  assert.equal(all.length, 3);            // capped
  assert.equal(all[0].title, 't4');       // newest first
  assert.ok(all[0].id > all[1].id);
});

test('log: audience filtering respects permissions', () => {
  const log = makeLog();
  log.push({ type: 'added', title: 'public' });
  log.push({ type: 'download', title: 'dl', audience: 'download' });
  log.push({ type: 'organizer', title: 'org', audience: 'organizer' });

  const admin = log.list({ role: 'admin' }).map((e) => e.title);
  assert.deepEqual(admin.sort(), ['dl', 'org', 'public']);

  const downloader = log.list({ role: 'user', permissions: ['canDownload'] }).map((e) => e.title);
  assert.deepEqual(downloader.sort(), ['dl', 'public']);

  const plain = log.list({ role: 'user', permissions: [] }).map((e) => e.title);
  assert.deepEqual(plain, ['public']);
});
