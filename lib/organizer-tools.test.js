const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOrganizerFixQueue, upsertAlias, loadAliases } = require('./organizer-tools');

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

test('review entries written by a test run (Python temp dirs) never reach Needs Review', () => {
  // A unit-test run once wrote its fixtures into the live log, and 17 of the 62
  // entries the page showed were fake ("Kraven... exists at /tmp/tmpnjzco7po/...").
  const real = '[2026-10-08 20:42:21] REVIEW: {"type": "movie", "title": "Insidious", "source": "Insidious (2026) [1080p]", "reason": "Destination conflict: a.mkv -> /mnt/media/Movies/Insidious (2026)/Insidious (2026).mkv; source retained"}';
  const fixture = '[2026-10-16 09:13:37] REVIEW: {"type": "movie", "title": "Kraven the Hunter", "source": "Kraven (2024)", "reason": "Movie already exists at /tmp/tmpnjzco7po/Movies/Kraven - the Hunter (2024); source retained"}';
  const queue = parseOrganizerFixQueue([fixture, real, fixture], []);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].title, 'Insidious');
});

// ── review notes are cleared when the file they were about is imported later ─────────────────
const reviewNote = (stamp, source, reason, file) =>
  `[2026-10-16 ${stamp}] REVIEW: ${JSON.stringify({ type: 'show', title: 'Narcos', source, reason, ...(file ? { file } : {}) })}`;
const movedLine = (stamp, release, name) =>
  `[2026-10-16 ${stamp}] EVENT: ${JSON.stringify({ event: 'moved', release, source: `/share/${release}/${name}`, destination: `/lib/Narcos/Extras/${name}` })}`;
const PACK = 'Narcos.S01-S03';
const noteAbout = (queue, file) => queue.find(entry => entry.reason.includes(file));

test('a review note is resolved when that file is imported afterwards', () => {
  const queue = parseOrganizerFixQueue([
    reviewNote('09:00:00', PACK, 'Missing or ambiguous season/episode: Deleted Scenes.mkv; source retained', 'Deleted Scenes.mkv'),
    reviewNote('09:00:00', PACK, 'Missing or ambiguous season/episode: Behind the Scenes.mkv; source retained', 'Behind the Scenes.mkv'),
    movedLine('10:00:00', PACK, 'Deleted Scenes.mkv'),
  ]);
  const done = noteAbout(queue, 'Deleted Scenes.mkv');
  assert.equal(done.resolved, true);
  assert.equal(done.status, 'resolved');
  assert.equal(done.resolution, 'Imported after review');
  assert.equal(noteAbout(queue, 'Behind the Scenes.mkv').resolved, false, 'the other note stays open');
});

test('older notes without a file field are matched by the name inside their reason', () => {
  const queue = parseOrganizerFixQueue([
    reviewNote('09:00:00', PACK, 'Missing or ambiguous season/episode: Deleted Scenes.mkv; source retained'),
    reviewNote('09:00:00', PACK, 'Not filed as an extra (it looks like a sample): sample.mkv; source retained'),
    reviewNote('09:00:00', PACK, 'Destination conflict: Trailer.mkv -> /lib/Narcos/Extras/Trailer.mkv; source retained'),
    reviewNote('09:00:00', PACK, 'Could not import Promo.mkv: [Errno 28] No space left; source retained'),
    movedLine('10:00:00', PACK, 'Deleted Scenes.mkv'), movedLine('10:00:01', PACK, 'sample.mkv'),
    movedLine('10:00:02', PACK, 'Trailer.mkv'), movedLine('10:00:03', PACK, 'Promo.mkv'),
  ]);
  assert.deepEqual(queue.map(entry => entry.resolved), [true, true, true, true]);
});

test('a move that happened before the note, or for another release or file, resolves nothing', () => {
  const reason = 'Missing or ambiguous season/episode: Deleted Scenes.mkv; source retained';
  const before = parseOrganizerFixQueue([movedLine('08:00:00', PACK, 'Deleted Scenes.mkv'), reviewNote('09:00:00', PACK, reason, 'Deleted Scenes.mkv')]);
  assert.equal(before[0].resolved, false);
  const other = parseOrganizerFixQueue([
    reviewNote('09:00:00', PACK, reason, 'Deleted Scenes.mkv'),
    movedLine('10:00:00', 'Another.Pack', 'Deleted Scenes.mkv'),     // same file name, different release
    movedLine('10:00:01', PACK, 'Deleted Scenes 2.mkv'),             // same release, different file
    movedLine('10:00:02', PACK, 'deleted scenes.mkv'),               // names are exact, not case-folded
  ]);
  assert.equal(other[0].resolved, false);
});

test('the same note appearing again after the import reopens it', () => {
  const reason = 'Missing or ambiguous season/episode: Deleted Scenes.mkv; source retained';
  const queue = parseOrganizerFixQueue([
    reviewNote('09:00:00', PACK, reason, 'Deleted Scenes.mkv'),
    movedLine('10:00:00', PACK, 'Deleted Scenes.mkv'),
    reviewNote('11:00:00', PACK, reason, 'Deleted Scenes.mkv'),
  ]);
  assert.equal(queue[0].resolved, false);
  assert.equal(queue[0].status, 'open');
  assert.equal(queue[0].count, 2);
});

test('an event with no release, or lines written by a test run, resolve nothing', () => {
  const reason = 'Missing or ambiguous season/episode: Deleted Scenes.mkv; source retained';
  const queue = parseOrganizerFixQueue([
    reviewNote('09:00:00', PACK, reason, 'Deleted Scenes.mkv'),
    `[2026-10-16 10:00:00] EVENT: ${JSON.stringify({ event: 'moved', source: `/share/${PACK}/Deleted Scenes.mkv`, destination: '/lib/x.mkv' })}`,
    movedLine('10:00:01', PACK, 'Deleted Scenes.mkv').replace('/share/', '/tmp/tmpab12cd34/share/'),
  ]);
  assert.equal(queue[0].resolved, false);
});

test('an import resolves a review of its own release only, even when the title is shared', () => {
  const queue = parseOrganizerFixQueue([
    reviewNote('09:00:00', 'Narcos.S01', 'Missing or ambiguous season/episode: Trailer.mkv; source retained', 'Trailer.mkv'),
    reviewNote('09:00:01', 'Narcos.S02', 'Missing or ambiguous season/episode: Trailer.mkv; source retained', 'Trailer.mkv'),
    movedLine('10:00:00', 'Narcos.S02', 'Trailer.mkv'),
  ]);
  const bySource = Object.fromEntries(queue.map(entry => [entry.source, entry.resolved]));
  assert.deepEqual(bySource, { 'Narcos.S01': false, 'Narcos.S02': true });
});

// Fix & retry takes an IMDb link or number for a film OMDb cannot find by title (The Weight, 2026).
test('upsertAlias keeps an IMDb number from a link, and ties it to the release year', () => {
  const aliases = [];
  for (const to of ['https://www.imdb.com/title/tt10794054/?ref_=nv_sr_srsg_0', 'imdb.com/title/tt10794054', ' TT10794054 ']) {
    const saved = upsertAlias(aliases, { from: 'The Weight', to, type: 'movie', year: '2026' });
    assert.equal(saved.to, 'tt10794054');
    assert.equal(saved.year, '2026');
  }
  assert.equal(aliases.length, 1);
  // A title alias is unchanged and carries no year; the same title in another year is its own rule.
  const title = upsertAlias(aliases, { from: 'The Weight', to: 'The Weight', type: 'movie', year: '2012' });
  assert.equal(title.to, 'The Weight'); assert.equal(title.year, undefined);
  assert.equal(aliases.length, 2);
  assert.equal(upsertAlias(aliases, { from: 'Show', to: 'tt123', type: 'movie' }).to, 'tt123', 'too short to be an IMDb number: kept as typed');
});

test('the year of an IMDb-number alias survives being loaded and saved again', () => {
  const file = { aliases: [{ id: 'a', from: 'The Weight', to: 'tt10794054', type: 'movie', year: '2026', createdAt: 1, updatedAt: 2 },
    { id: 'b', from: 'Heat', to: 'Heat', type: 'movie', year: 'junk', createdAt: 1, updatedAt: 2 }] };
  const loaded = loadAliases(() => file, '/x');
  assert.equal(loaded[0].year, '2026');
  assert.equal('year' in loaded[1], false);
});

test('an IMDb link pasted after the suggested title still counts as the number', () => {
  const aliases = [];
  assert.equal(upsertAlias(aliases, { from: 'The Weight', to: 'The Weight https://www.imdb.com/title/tt10794054/', type: 'movie', year: '2026' }).to, 'tt10794054');
  assert.equal(upsertAlias(aliases, { from: 'Heat', to: 'Heat (1995) tt0113277', type: 'movie' }).to, 'tt0113277');
  assert.equal(upsertAlias(aliases, { from: 'Matt Tt1234567x', to: 'Matt Tt1234567x', type: 'movie' }).to, 'Matt Tt1234567x', 'not a whole word: a title');
});

test('a title typed for a release that was pinned replaces the pin, so the correction takes effect', () => {
  const aliases = [];
  upsertAlias(aliases, { from: 'The Weight', to: 'tt10794054', type: 'movie', year: '2026' });
  upsertAlias(aliases, { from: 'The Weight', to: 'tt10794054', type: 'movie' });   // an older pin without a year
  upsertAlias(aliases, { from: 'The Weight', to: 'tt2384688', type: 'movie', year: '2012' });
  upsertAlias(aliases, { from: 'The Weight', to: 'The Weight of Water', type: 'movie', year: '2026' });
  assert.deepEqual(aliases.map(a => [a.to, a.year]).sort(), [['The Weight of Water', undefined], ['tt2384688', '2012']],
    'the 2026 pin and the year-less pin are gone; the 2012 pin is another release');
});

test('a pin for one year is not suggested for another year\'s release of the same title', () => {
  const pin = { from: 'The Weight', to: 'tt10794054', type: 'movie', year: '2026' };
  const lines = y => [
    `[2026-10-26 17:04:35] [MOVIE] Found: The Weight ${y} 1080p WEB-DL`,
    `[2026-10-26 17:04:35]   Parsed: title='The Weight', year=${y}`,
    `[2026-10-26 17:04:35] SKIP: No confident OMDb match for: The Weight (${y})`,
  ];
  assert.equal(parseOrganizerFixQueue(lines(2026), [pin])[0].suggestedAlias, 'tt10794054');
  assert.equal(parseOrganizerFixQueue(lines(2012), [pin])[0].suggestedAlias, '');
});
