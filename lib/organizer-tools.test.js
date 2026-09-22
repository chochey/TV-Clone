const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOrganizerFixQueue, upsertAlias } = require('./organizer-tools');

test('parseOrganizerFixQueue extracts TV OMDb misses from organizer logs', () => {
  const queue = parseOrganizerFixQueue([
    '[2026-05-22 17:40:33] [TV] Found: SAS.Rogue.Heroes.S01.1080p.BluRay.x265-RARBG',
    "[2026-05-22 17:40:33] Parsed: title='SAS Rogue Heroes', S01E??",
    '[2026-05-22 17:40:33] SKIP: No OMDb match for series: SAS Rogue Heroes',
  ], [{ from: 'SAS Rogue Heroes', to: 'Rogue Heroes', type: 'series' }]);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].type, 'show');
  assert.equal(queue[0].title, 'SAS Rogue Heroes');
  assert.equal(queue[0].source, 'SAS.Rogue.Heroes.S01.1080p.BluRay.x265-RARBG');
  assert.equal(queue[0].suggestedAlias, 'Rogue Heroes');
});

test('parseOrganizerFixQueue surfaces a "actually a series" skip with an accurate reason', () => {
  // Real case: "Band of Brothers" (2001) is OMDb type 'series'. The movie
  // matcher's &type=movie filter hides that entry and matches an unrelated
  // 30-minute documentary instead, correctly rejected — leaving a log line
  // that used to read exactly like "OMDb has never heard of this title".
  // This message distinguishes the two so the fix-queue reason is honest.
  const queue = parseOrganizerFixQueue([
    '[2026-08-15 23:47:22] [MOVIE] Found: Band of Brothers (1080p x265 HQ Joy)',
    "[2026-08-15 23:47:22] SKIP: 'Band of Brothers' is a TV series in OMDb (Band of Brothers, 2001), not a movie — needs season/episode markers or manual placement, not a rename",
  ], []);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].type, 'movie');
  assert.equal(queue[0].title, 'Band of Brothers');
  assert.equal(queue[0].source, 'Band of Brothers (1080p x265 HQ Joy)');
  assert.match(queue[0].reason, /Actually a TV series in OMDb \(Band of Brothers, 2001\)/);
});

test('the folder-rescan variant of the "actually a series" skip also parses', () => {
  // The library-folder rescan path logs a shorter form with two leading
  // spaces and no trailing "needs season/episode markers" clause.
  const queue = parseOrganizerFixQueue([
    '[2026-08-15 23:47:22] [MOVIE] Found: Band of Brothers (1080p x265 HQ Joy)',
    "[2026-08-15 23:47:22]   SKIP: 'Band of Brothers' is a TV series in OMDb (Band of Brothers, 2001), not a movie",
  ], []);

  assert.equal(queue.length, 1);
  assert.match(queue[0].reason, /Actually a TV series in OMDb \(Band of Brothers, 2001\)/);
});

test('upsertAlias replaces an existing title/type pair', () => {
  const aliases = [];
  const first = upsertAlias(aliases, { from: 'SAS Rogue Heroes', to: 'Rogue Heroes', type: 'series' });
  const second = upsertAlias(aliases, { from: 'sas rogue heroes', to: 'Rogue Heroes 2022', type: 'series' });

  assert.equal(aliases.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(aliases[0].to, 'Rogue Heroes 2022');
});


test('structured safety reviews preserve sources and are not title-alias corrections', () => {
  const lines = ['pack-one', 'pack-two'].map(source => '[2026-09-22 18:00:00] REVIEW: ' + JSON.stringify({
    type: 'show', title: "Show's Name", source,
    reason: 'Missing or ambiguous season/episode: bonus.mkv; source retained',
  }));
  const queue = parseOrganizerFixQueue(lines);
  assert.equal(queue.length, 2);
  assert.notEqual(queue[0].id, queue[1].id);
  assert.ok(queue.every(entry => entry.manualReview));
  assert.deepEqual(queue.map(entry => entry.source).sort(), ['pack-one', 'pack-two']);
});
test('incomplete safety review log entries do not break the review queue', () => {
  assert.deepEqual(parseOrganizerFixQueue(['[2026-09-22 18:00:00] REVIEW: {']), []);
});
