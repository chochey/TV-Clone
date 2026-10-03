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

const blackPearlSource = 'Pirates of the Caribbean - Curse of the Black Pearl (2003) [1080p]';
const blackPearlTitle = 'Pirates of the Caribbean - Curse of the Black Pearl';
const blackPearlMatch = 'Pirates of the Caribbean: The Curse of the Black Pearl';
const stamp = (time, message) => `[2026-10-03 ${time}] ${message}`;
function movieFailure(source, title = blackPearlTitle, time = '00:00:29', year = '2003') {
  return [
    stamp(time, `[MOVIE] Found: ${source}`),
    stamp(time, `  Parsed: title='${title}', year=${year}`),
    stamp(time, `SKIP: No confident OMDb match for: ${title} (${year})`),
  ];
}
function movieMatch(source, title = blackPearlMatch, time = '00:01:35', year = '2003') {
  return [
    stamp(time, `[MOVIE] Found: ${source}`),
    stamp(time, `  Parsed: title='${blackPearlTitle}', year=${year}`),
    stamp(time, `  OMDb match: ${title} (${year})`),
  ];
}
function review(source, reason, time = '00:01:35', type = 'movie', title = blackPearlMatch) {
  return stamp(time, 'REVIEW: ' + JSON.stringify({ type, title, source, reason }));
}

test('a real Black Pearl retry resolves the stale title failure but retains its duplicate review', () => {
  const reason = 'Movie already exists at /mnt/media/Movies/Pirates of the Caribbean The Curse of the Black Pearl (2003); source retained for comparison';
  const queue = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource),
    ...movieMatch(blackPearlSource),
    review(blackPearlSource, reason),
  ]);
  assert.equal(queue.length, 2);
  const lookup = queue.find(item => !item.manualReview);
  const duplicate = queue.find(item => item.manualReview);
  assert.equal(lookup.source, blackPearlSource);
  assert.equal(lookup.title, blackPearlTitle);
  assert.equal(lookup.resolved, true);
  assert.equal(lookup.status, 'resolved');
  assert.equal(lookup.resolvedAt, Date.parse('2026-10-03T00:01:35'));
  assert.equal(lookup.resolution, `OMDb match: ${blackPearlMatch} (2003)`);
  assert.equal(duplicate.resolved, false);
  assert.equal(duplicate.status, 'open');
  assert.equal(duplicate.reason, reason);
  assert.notEqual(lookup.id, duplicate.id);
});

test('a successful retry resolves a lookup without requiring the source to disappear or a move log', () => {
  const source = 'Most Dangerous Game (2020) [1080p]';
  const [item] = parseOrganizerFixQueue([
    ...movieFailure(source, 'Most Dangerous Game', '00:00:00', '2020'),
    ...movieMatch(source, 'Most Dangerous Game', '00:02:00', '2020'),
    stamp('00:02:01', 'Source folder retained because non-media advertising files remain'),
  ]);
  assert.equal(item.source, source);
  assert.equal(item.resolved, true);
  assert.equal(item.resolvedAt, Date.parse('2026-10-03T00:02:00'));
});

test('a structured manual review resolves the exact release lookup when the match line is missing', () => {
  const queue = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource),
    review(blackPearlSource, 'Movie already exists; source retained for comparison'),
  ]);
  assert.equal(queue.find(item => !item.manualReview).resolved, true);
  assert.equal(queue.find(item => !item.manualReview).resolution, 'Title matched; source needs manual review');
  assert.equal(queue.find(item => item.manualReview).resolved, false);
});

test("Dead Man's Chest apostrophes survive Parsed logs and duplicate reviews", () => {
  const source = "Pirates of the Caribbean - Dead Man's Chest (2006) [1080p]";
  const title = "Pirates of the Caribbean - Dead Man's Chest";
  const matched = "Pirates of the Caribbean: Dead Man's Chest";
  const queue = parseOrganizerFixQueue([
    stamp('00:00:00', `[MOVIE] Found: ${source}`),
    stamp('00:00:00', `  Parsed: title='${title}', year=2006`),
    stamp('00:00:00', 'SKIP: No confident OMDb match'),
    stamp('00:01:00', `[MOVIE] Found: ${source}`),
    stamp('00:01:00', `  Parsed: title='${title}', year=2006`),
    stamp('00:01:00', `  OMDb match: ${matched} (2006)`),
    review(source, 'Movie already exists; source retained for comparison', '00:01:00', 'movie', matched),
  ]);
  const lookup = queue.find(item => !item.manualReview);
  assert.equal(lookup.title, title);
  assert.equal(lookup.year, '2006');
  assert.equal(lookup.source, source);
  assert.equal(lookup.resolved, true);
  assert.equal(queue.find(item => item.manualReview).title, matched);
});

test('separate unresolved episode reasons remain open across repeated matches and reviews', () => {
  const source = "Show's Name S01 1080p";
  const firstReason = 'Episode destination already exists: S01E01.mkv; source retained';
  const secondReason = 'Episode destination already exists: S01E02.mkv; source retained';
  const queue = parseOrganizerFixQueue([
    stamp('00:00:00', `[TV] Found: ${source}`),
    stamp('00:00:00', "  Parsed: title='Show's Name', S01E??"),
    stamp('00:00:00', "SKIP: No OMDb match for series: Show's Name"),
    stamp('00:01:00', `[TV] Found: ${source}`),
    stamp('00:01:00', "  OMDb match: Show's Name (2020)"),
    review(source, firstReason, '00:01:00', 'show', "Show's Name"),
    review(source, secondReason, '00:01:00', 'show', "Show's Name"),
    stamp('00:02:00', `[TV] Found: ${source}`),
    stamp('00:02:00', "  OMDb match: Show's Name (2020)"),
    review(source, firstReason, '00:02:00', 'show', "Show's Name"),
  ]);
  assert.equal(queue.length, 3);
  assert.equal(queue.find(item => !item.manualReview).resolved, true);
  const reviews = queue.filter(item => item.manualReview);
  assert.ok(reviews.every(item => item.resolved === false && item.status === 'open'));
  assert.equal(new Set(reviews.map(item => item.id)).size, 2);
  assert.equal(reviews.find(item => item.reason === firstReason).count, 2);
  assert.equal(reviews.find(item => item.reason === secondReason).count, 1);
});

test('lookup resolution never merges same-title releases, prefixes, case, whitespace, or media types', () => {
  const sources = [blackPearlSource, `${blackPearlSource}.extended`, blackPearlSource.toLowerCase(),
    blackPearlSource.replace(' - ', '  - ')];
  const queue = parseOrganizerFixQueue([
    ...sources.flatMap(source => movieFailure(source)),
    stamp('00:00:29', `[TV] Found: ${blackPearlSource}`),
    stamp('00:00:29', `SKIP: No OMDb match for series: ${blackPearlTitle}`),
    ...movieMatch(blackPearlSource),
  ]);
  assert.equal(queue.length, 5);
  assert.equal(new Set(queue.map(item => item.id)).size, 5);
  assert.equal(queue.filter(item => item.resolved).length, 1);
  assert.ok(queue.find(item => item.source === blackPearlSource && item.type === 'movie').resolved);
  assert.ok(queue.filter(item => item.source !== blackPearlSource || item.type !== 'movie').every(item => !item.resolved));
});

test('a failed retry reopens the same lookup issue after a successful match', () => {
  const initial = parseOrganizerFixQueue(movieFailure(blackPearlSource))[0];
  const queue = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource),
    ...movieMatch(blackPearlSource),
    ...movieFailure(blackPearlSource, blackPearlTitle, '00:03:00'),
  ]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, initial.id);
  assert.equal(queue[0].count, 2);
  assert.equal(queue[0].resolved, false);
  assert.equal(queue[0].status, 'open');
  assert.equal(queue[0].resolvedAt, undefined);
  assert.equal(queue[0].resolution, undefined);
  assert.equal(queue[0].lastSeen, Date.parse('2026-10-03T00:03:00'));
});

test('a second failed attempt never resolves the first lookup issue', () => {
  const [item] = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource),
    ...movieFailure(blackPearlSource, blackPearlTitle, '00:01:00'),
  ]);
  assert.equal(item.count, 2);
  assert.equal(item.resolved, false);
  assert.equal(item.status, 'open');
});

test('events within one timestamp follow log order, including failure recurrence', () => {
  const [item] = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource),
    ...movieMatch(blackPearlSource, blackPearlMatch, '00:00:29'),
    ...movieFailure(blackPearlSource),
  ]);
  assert.equal(item.count, 2);
  assert.equal(item.resolved, false);
});

test('older out-of-order matches and failures do not overwrite the newer resolution state', () => {
  const [open] = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource, blackPearlTitle, '00:03:00'),
    ...movieMatch(blackPearlSource),
  ]);
  assert.equal(open.resolved, false);
  const [resolved] = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource),
    ...movieMatch(blackPearlSource),
    ...movieFailure(blackPearlSource, blackPearlTitle, '00:00:40'),
  ]);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.count, 2);
  const [matchedAgain] = parseOrganizerFixQueue([
    ...movieFailure(blackPearlSource),
    ...movieMatch(blackPearlSource),
    ...movieMatch(blackPearlSource, blackPearlMatch, '00:03:00'),
    ...movieFailure(blackPearlSource, blackPearlTitle, '00:02:00'),
  ]);
  assert.equal(matchedAgain.resolved, true);
});

test('library-folder and new-scan match lines cannot resolve the previous incoming source', () => {
  for (const boundary of ['[1/10] Checking: A library movie (2003)', 'Scanning /mnt/media/incoming...']) {
    const [item] = parseOrganizerFixQueue([
      ...movieFailure(blackPearlSource),
      stamp('00:01:00', boundary),
      stamp('00:01:00', `  Parsed: title='${blackPearlMatch}', year=2003`),
      stamp('00:01:00', `  OMDb match: ${blackPearlMatch} (2003)`),
    ]);
    assert.equal(item.resolved, false, boundary);
  }
});

test('a title-only failure is never resolved by a same-title release without exact source evidence', () => {
  const queue = parseOrganizerFixQueue([
    stamp('00:00:00', `SKIP: No confident OMDb match for: ${blackPearlTitle} (2003)`),
    ...movieMatch(blackPearlSource),
  ]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].source, '');
  assert.equal(queue[0].resolved, false);
});
