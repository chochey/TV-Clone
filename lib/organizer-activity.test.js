const test = require('node:test');
const assert = require('node:assert/strict');
const { organizerActivity, filterActivity } = require('./organizer-activity');

const opts = { sourceDir: '/mnt/media/Share', libraryRoots: ['/mnt/media/Movies', '/mnt/media/TV'] };
const at = (clock, message) => `[2026-10-16 ${clock}] ${message}`;
const release = 'The Sopranos (1999) Season 1-6 S01-S06 (1080p BluRay x265 HEVC 10bit AAC 5.1 ImE)';
const episode = (season, number, title) => {
  const source = `/mnt/media/Share/${release}/Season ${season}/The Sopranos (1999) - S0${season}E${number} - ${title} (1080p BluRay x265 ImE).mkv`;
  const destination = `/mnt/media/TV/The Sopranos (1999)/Season 0${season}/The Sopranos - S0${season}E${number} - ${title}.mkv`;
  return [
    at('19:16:46', `Import source: ${source} -> ${destination}`),
    at('19:16:46', `Moved -> ${destination}`),
    at('19:16:47', `EVENT: ${JSON.stringify({ event: 'moved', release, source, destination })}`),
  ];
};

test('a season import is one entry: show, episode range, destination, notes, and the episodes inside', () => {
  const lines = [
    at('19:16:46', `[TV] Found: ${release}`),
    ...episode(1, '10', 'A Hit Is a Hit'), ...episode(1, '11', 'Nobody Knows Anything'), ...episode(2, '01', "Guy Walks Into a Psychiatrist's Office"),
    at('19:16:47', `Deleted source folder: ${release}`),
    at('19:16:47', 'Scan complete. Movies: 0/0, TV: 1/1'),
  ];
  const entries = organizerActivity(lines, opts);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.kind, 'import'); assert.equal(entry.type, 'show');
  assert.equal(entry.title, 'The Sopranos (1999)');
  assert.equal(entry.count, 3);
  assert.equal(entry.summary, '3 episodes · S01E10–S02E01');
  assert.equal(entry.to, 'TV/The Sopranos (1999)');
  assert.equal(entry.release, release);
  assert.deepEqual(entry.notes, ['Source folder deleted']);
  assert.equal(entry.at, Date.parse('2026-10-16T19:16:47'));
  assert.deepEqual(entry.items[0], { label: 'S01E10 · A Hit Is a Hit', from: `Share/${release}/Season 1/The Sopranos (1999) - S01E10 - A Hit Is a Hit (1080p BluRay x265 ImE).mkv`,
    to: 'TV/The Sopranos (1999)/Season 01/The Sopranos - S01E10 - A Hit Is a Hit.mkv' });
  assert.equal(entry.items[2].label, "S02E01 · Guy Walks Into a Psychiatrist's Office");
});

test('older history without events still groups, a film shows its file, and leftovers are noted', () => {
  const lines = [
    at('10:55:40', '[MOVIE] Found: Signal One (2026) [1080p] [WEBRip] [5.1] [YTS.BZ]'),
    at('10:55:40', "  Parsed: title='Signal One', year=2026"),
    at('10:55:41', '  OMDb match: Signal One (2026)'),
    at('10:55:41', 'Import source: /mnt/media/Share/Signal One (2026) [1080p] [WEBRip] [5.1] [YTS.BZ]/Signal.One.2026.1080p.WEBRip.mkv -> /mnt/media/Movies/Signal One (2026)/Signal One (2026).mkv'),
    at('10:55:41', 'Moved -> /mnt/media/Movies/Signal One (2026)/Signal One (2026).mkv'),
    at('10:55:41', 'Retained source folder with remaining files: Signal One (2026) [1080p] [WEBRip] [5.1] [YTS.BZ]'),
    at('10:55:41', 'Scan complete. Movies: 1/1, TV: 0/0'),
  ];
  const [entry] = organizerActivity(lines, opts);
  assert.equal(entry.kind, 'import'); assert.equal(entry.type, 'movie');
  assert.equal(entry.title, 'Signal One (2026)');
  assert.equal(entry.summary, 'Signal One (2026).mkv');
  assert.equal(entry.to, 'Movies/Signal One (2026)');
  assert.equal(entry.release, 'Signal One (2026) [1080p] [WEBRip] [5.1] [YTS.BZ]');
  assert.equal(entry.matched, 'Signal One (2026)');
  assert.deepEqual(entry.notes, ['Leftover files kept in Share']);
  assert.equal(entry.count, 1);
  // Without configured roots the folder names still tell the story.
  const bare = organizerActivity(lines, {})[0];
  assert.equal(bare.title, 'Signal One (2026)'); assert.equal(bare.to, 'Movies/Signal One (2026)');
  assert.deepEqual(bare.notes, ['Leftover files kept in the download folder']);
});

test('a move written in both forms counts once', () => {
  const lines = [at('19:16:46', `[TV] Found: ${release}`), ...episode(1, '10', 'A Hit Is a Hit')];
  assert.equal(organizerActivity(lines, opts)[0].count, 1);
});

test('skips carry the title and a plain reason, with the matching notes that led there', () => {
  const lines = [
    at('08:13:20', '[MOVIE] Found: Train.to.Busan.2.Peninsula.2020'),
    at('08:13:22', "  Rejected: year gap too large (2020 vs 2016, 4 years apart) - likely a different movie"),
    at('08:13:23', 'SKIP: No confident OMDb match for: Train to Busan 2.Peninsula. (2020)'),
    at('09:47:50', '  SKIP: Destination already exists: Suits - S01E07 - Play the Man.mkv'),
  ];
  const [exists, skipped] = organizerActivity(lines, opts);
  assert.equal(skipped.kind, 'skip');
  assert.equal(skipped.title, 'Train to Busan 2.Peninsula. (2020)');
  assert.equal(skipped.summary, 'No confident OMDb match');
  assert.deepEqual(skipped.notes, ['Rejected: year gap too large (2020 vs 2016, 4 years apart) - likely a different movie']);
  assert.equal(skipped.release, 'Train.to.Busan.2.Peninsula.2020');
  assert.equal(exists.kind, 'skip');
  assert.equal(exists.title, 'Suits - S01E07 - Play the Man.mkv');
  assert.equal(exists.summary, 'Already in the library');
});

test('a scan boundary ends a release, so a later skip does not inherit it', () => {
  const lines = [
    at('10:55:40', '[MOVIE] Found: Signal One (2026) [1080p] [WEBRip]'),
    at('10:55:41', 'Scan complete. Movies: 0/1, TV: 0/0'),
    at('11:30:00', 'SKIP: No confident OMDb match for: Mystery Film (2020)'),
  ];
  const [skip] = organizerActivity(lines, opts);
  assert.equal(skip.kind, 'skip'); assert.equal(skip.release, null);
  assert.deepEqual(filterActivity([skip], 'all', 'signal'), []);
});

test('review lines become one entry per title with every distinct reason', () => {
  const lines = [
    at('03:02:47', 'OMDb series lookup failed; no match accepted'),
    at('03:02:47', 'REVIEW: {"type": "movie", "title": "Kraven the Hunter", "source": "Kraven The Hunter (2024) [1080p] [WEBRip]", "reason": "Cannot verify existing movie folders: library root unreadable; source retained"}'),
    at('03:02:47', 'REVIEW: {"type": "movie", "title": "Kraven the Hunter", "source": "Kraven The Hunter (2024) [1080p] [WEBRip]", "reason": "Cannot verify existing movie folders: movie folder unreadable; source retained"}'),
    at('03:02:47', 'REVIEW: {"type": "movie", "title": "Kraven the Hunter", "source": "Kraven The Hunter (2024) [1080p] [WEBRip]", "reason": "Cannot verify existing movie folders: movie folder unreadable; source retained"}'),
  ];
  const entries = organizerActivity(lines, opts);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'review'); assert.equal(entries[0].type, 'movie');
  assert.equal(entries[0].title, 'Kraven the Hunter');
  assert.equal(entries[0].summary, 'Cannot verify existing movie folders: library root unreadable; source retained');
  assert.deepEqual(entries[0].notes, ['Cannot verify existing movie folders: movie folder unreadable; source retained', 'OMDb series lookup failed; no match accepted']);
  assert.equal(entries[0].release, 'Kraven The Hunter (2024) [1080p] [WEBRip]');
});

test('startup lines fold into one entry; heartbeats, empty scans and separators vanish', () => {
  const lines = [
    '\u0000\u0000\u0000[2026-10-16 12:36:36] Watching /mnt/media/Share (polling every 30s)',
    at('12:36:37', '============================================================'),
    at('12:36:37', 'Watching /mnt/media/Share (polling every 30s)'),
    at('12:36:37', 'Press Ctrl+C to stop'),
    at('12:41:37', 'Still watching...'),
    at('12:42:07', 'Scan complete. Movies: 0/0, TV: 0/0'),
  ];
  const entries = organizerActivity(lines, opts);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'start');
  assert.equal(entries[0].title, 'Organizer started');
  assert.equal(entries[0].summary, 'Checking Share every 30 s');
  assert.equal(entries[0].count, 2, 'the NUL-padded start line still reads as a start');
});

test('a folder that could not be deleted is a problem, or a note on the import it belongs to', () => {
  const alone = organizerActivity([at('12:32:44', "Could not delete folder /mnt/media/Share/Project Hail Mary (2026) [IMAX]: [Errno 39] Directory not empty: '/mnt/media/Share/Project Hail Mary (2026) [IMAX]'")], opts);
  assert.equal(alone[0].kind, 'problem');
  assert.equal(alone[0].title, 'Project Hail Mary (2026) [IMAX]');
  assert.equal(alone[0].summary, 'Could not delete the source folder: Directory not empty');
  const lines = [
    at('10:55:40', '[MOVIE] Found: Project Hail Mary (2026) [IMAX]'),
    at('10:55:41', 'Import source: /mnt/media/Share/Project Hail Mary (2026) [IMAX]/phm.mkv -> /mnt/media/Movies/Project Hail Mary (2026)/Project Hail Mary (2026).mkv'),
    at('10:55:41', 'Moved -> /mnt/media/Movies/Project Hail Mary (2026)/Project Hail Mary (2026).mkv'),
    at('10:55:42', "Could not delete folder /mnt/media/Share/Project Hail Mary (2026) [IMAX]: [Errno 39] Directory not empty: '/mnt/media/Share/Project Hail Mary (2026) [IMAX]'"),
  ];
  const entries = organizerActivity(lines, opts);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].notes, ['Could not delete the source folder: Directory not empty']);
});

test('a clean-up line in a later scan still lands on the entry for its release', () => {
  const lines = [
    at('03:02:47', '[MOVIE] Found: Kraven The Hunter (2024) [1080p] [WEBRip]'),
    at('03:02:47', 'REVIEW: {"type": "movie", "title": "Kraven the Hunter", "source": "Kraven The Hunter (2024) [1080p] [WEBRip]", "reason": "library root unreadable"}'),
    at('03:02:48', 'Scan complete. Movies: 0/1, TV: 0/0'),
    at('03:03:20', 'Removed empty source folder: Kraven The Hunter (2024) [1080p] [WEBRip]'),
    at('03:03:21', 'Removed empty source folder: Something Never Seen (2020)'),
  ];
  const entries = organizerActivity(lines, opts);
  assert.deepEqual(entries.map(e => e.kind), ['note', 'review']);
  assert.deepEqual(entries[1].notes, ['Source folder deleted']);
});

test('a clean-up line written before its outcome waits for it; one with no outcome at all stays a note', () => {
  const lines = [
    at('03:02:47', '[MOVIE] Found: Kraven The Hunter (2024) [1080p] [WEBRip]'),
    at('03:02:47', 'Removed empty source folder: Kraven The Hunter (2024) [1080p] [WEBRip]'),
    at('03:02:47', 'REVIEW: {"type": "movie", "title": "Kraven the Hunter", "source": "Kraven The Hunter (2024) [1080p] [WEBRip]", "reason": "library root unreadable"}'),
    at('03:02:48', 'Scan complete. Movies: 0/1, TV: 0/0'),
    at('04:00:00', 'Deleting source folder with 2 extra file(s): a.nfo, b.txt'),
    at('04:00:01', 'Scan complete. Movies: 0/0, TV: 0/0'),
  ];
  const entries = organizerActivity(lines, opts);
  assert.deepEqual(entries.map(e => [e.kind, e.notes]), [['note', []], ['review', ['Source folder deleted']]]);
  assert.equal(entries[0].at, Date.parse('2026-10-16T04:00:00'));
});

test('a title backfill run is one entry with the renamed files inside', () => {
  const lines = [
    at('11:10:40', '[BACKFILL] Adding episode titles in /mnt/media/TV'),
    at('11:10:44', '[BACKFILL] Renamed: /mnt/media/TV/Zoo (2015)/Season 03/Zoo - S03E12.srt -> Zoo - S03E12 - West Side Story.srt'),
    at('11:10:44', '[BACKFILL] Renamed: /mnt/media/TV/Zoo (2015)/Season 03/Zoo - S03E13.srt -> Zoo - S03E13 - The Barrier.srt'),
    at('11:10:45', '[BACKFILL] Still without a title after this run: 3 files'),
    at('11:10:45', '[BACKFILL] To undo this run: python3 backfill.py --undo 2026-10-16'),
  ];
  const [entry] = organizerActivity(lines, opts);
  assert.equal(entry.kind, 'backfill');
  assert.equal(entry.title, 'Episode titles added to file names');
  assert.equal(entry.summary, '2 files renamed');
  assert.equal(entry.count, 2);
  assert.deepEqual(entry.items[0], { label: 'Zoo - S03E12 - West Side Story.srt', from: 'Zoo - S03E12.srt', to: 'TV/Zoo (2015)/Season 03' });
  assert.deepEqual(entry.notes, ['Still without a title after this run: 3 files']);
});

test('test artifacts never appear, and an unknown line is kept as a note', () => {
  const lines = [
    at('01:06:04', 'Cleared stale movie-less destination folder: /tmp/tmpol7ce99j/Movies/Kraven the Hunter (2024)'),
    at('01:06:05', 'EVENT: {"event": "moved", "release": "X", "source": "/tmp/tmpol7ce99j/Share/X/a.mkv", "destination": "/tmp/tmpol7ce99j/Movies/X/a.mkv"}'),
    at('01:06:06', 'Something this page has not seen before'),
    at('01:06:07', "  Strategy: exact + year, query: 'Pirates'"),
  ];
  const entries = organizerActivity(lines, opts);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'note');
  assert.equal(entries[0].title, 'Something this page has not seen before');
});

test('entries come newest first with unique ids, and filters and search narrow them', () => {
  const lines = [
    at('08:00:00', 'Watching /mnt/media/Share (polling every 30s)'),
    at('09:00:00', 'SKIP: No confident OMDb match for: Mystery Film (2020)'),
    at('10:00:00', `[TV] Found: ${release}`),
    at('10:00:01', `EVENT: ${JSON.stringify({ event: 'moved', release, source: `/mnt/media/Share/${release}/Season 1/The Sopranos (1999) - S01E10 - A Hit Is a Hit.mkv`, destination: '/mnt/media/TV/The Sopranos (1999)/Season 01/The Sopranos - S01E10 - A Hit Is a Hit.mkv' })}`),
    at('11:00:00', 'REVIEW: {"type": "movie", "title": "Kraven the Hunter", "source": "Kraven", "reason": "unreadable"}'),
  ];
  const entries = organizerActivity(lines, opts);
  assert.deepEqual(entries.map(e => e.kind), ['review', 'import', 'skip', 'start']);
  assert.equal(new Set(entries.map(e => e.id)).size, 4);
  assert.deepEqual(filterActivity(entries, 'problems').map(e => e.kind), ['review', 'skip']);
  assert.deepEqual(filterActivity(entries, 'imports').map(e => e.kind), ['import']);
  assert.deepEqual(filterActivity(entries, 'organizer').map(e => e.kind), ['start']);
  assert.deepEqual(filterActivity(entries, 'all', 'sopranos').map(e => e.kind), ['import']);
  assert.deepEqual(filterActivity(entries, 'all', 'hit is a hit').map(e => e.kind), ['import']);
  assert.deepEqual(filterActivity(entries, 'all', 'kraven').map(e => e.title), ['Kraven the Hunter']);
  // The old filter names from the raw-log days still work.
  assert.deepEqual(filterActivity(entries, 'errors').map(e => e.kind), ['review', 'skip']);
  assert.deepEqual(filterActivity(entries, 'moves').map(e => e.kind), ['import']);
});

test('an older "Moved" line with no source still counts, under the release that was found', () => {
  const lines = [
    at('03:06:52', '[MOVIE] Found: Runner Runner (2013) [1080p]'),
    at('03:06:52', '  OMDb match: Runner Runner (2013)'),
    at('03:06:52', 'Moved -> /mnt/media/Movies/Runner Runner (2013)/Runner Runner (2013).mp4'),
    at('03:06:52', 'Deleting source folder with 1 extra file(s): WWW.YIFY-TORRENTS.COM.jpg'),
    at('03:06:52', 'Deleted source folder: Runner Runner (2013) [1080p]'),
  ];
  const [entry] = organizerActivity(lines, opts);
  assert.equal(entry.kind, 'import'); assert.equal(entry.title, 'Runner Runner (2013)'); assert.equal(entry.count, 1);
  assert.equal(entry.release, 'Runner Runner (2013) [1080p]');
  assert.deepEqual(entry.items[0], { label: 'Runner Runner (2013)', from: '', to: 'Movies/Runner Runner (2013)/Runner Runner (2013).mp4' });
  assert.deepEqual(entry.notes, ['Source folder deleted (1 extra file removed)']);
});

test('subtitles ride along with an import but are not counted as episodes or films', () => {
  const dest = n => `/mnt/media/TV/Teacup (2024)/Season 01/Teacup - S01E0${n} - Title ${n}`;
  const lines = [
    at('09:00:00', '[TV] Found: Teacup.S01.1080p'),
    at('09:00:01', `Moved -> ${dest(1)}.mp4`), at('09:00:01', `Moved -> ${dest(1)}.srt`), at('09:00:01', `Moved -> ${dest(1)}.eng.sdh.srt`),
    at('09:00:02', `Moved -> ${dest(2)}.mp4`), at('09:00:02', `Moved -> ${dest(2)}.srt`),
    at('09:05:00', 'Scan complete. Movies: 0/0, TV: 1/1'),
    at('10:55:41', '[MOVIE] Found: Signal One (2026) [1080p] [WEBRip]'),
    at('10:55:41', 'Moved -> /mnt/media/Movies/Signal One (2026)/Signal One (2026).mp4'),
    at('10:55:41', 'Moved -> /mnt/media/Movies/Signal One (2026)/Signal One (2026).srt'),
  ];
  const [film, show] = organizerActivity(lines, opts);
  assert.equal(show.count, 2); assert.equal(show.summary, '2 episodes · S01E01–S01E02');
  assert.deepEqual(show.notes, ['3 subtitle files']);
  assert.equal(show.items.length, 5); assert.equal(show.items[0].label, 'S01E01 · Title 1');
  assert.equal(film.count, 1); assert.equal(film.summary, 'Signal One (2026).mp4');
  assert.deepEqual(film.notes, ['1 subtitle file']);
});

test('the heartbeat with counts is still a heartbeat, and repeats of a skip, a review or a restart fold into one entry', () => {
  const lines = [
    at('08:00:00', 'Watching /mnt/media/Share (polling every 30s)'),
    at('08:00:01', 'Watching /mnt/media/Share (polling every 30s)'),
    at('08:00:02', 'Watching /mnt/media/Share (polling every 30s)'),
    at('08:05:00', 'Still watching... 12 scans, 0 imports since start'),
    at('09:00:00', '[TV] Found: Grimm.S01'), at('09:00:01', 'SKIP: No episode number in: Gag Reel.mkv'), at('09:00:02', 'Scan complete. Movies: 0/0, TV: 0/1'),
    at('09:30:00', '[TV] Found: Grimm.S01'), at('09:30:01', 'SKIP: No episode number in: Gag Reel.mkv'), at('09:30:02', 'Scan complete. Movies: 0/0, TV: 0/1'),
    at('10:00:00', 'REVIEW: {"type": "series", "title": "Narcos", "source": "Narcos.S01", "reason": "Season folder unreadable"}'),
    at('10:30:00', 'REVIEW: {"type": "series", "title": "Narcos", "source": "Narcos.S01", "reason": "Season folder unreadable"}'),
    at('11:00:00', 'SKIP: No OMDb match for series: Below'),
  ];
  const entries = organizerActivity(lines, opts);
  assert.deepEqual(entries.map(e => [e.kind, e.count || 1]), [['skip', 1], ['review', 2], ['skip', 2], ['start', 3]]);
  const [below, narcos, gag, start] = entries;
  assert.equal(below.title, 'Below'); assert.equal(below.summary, 'No OMDb match for the series');
  assert.equal(gag.title, 'Gag Reel.mkv'); assert.equal(gag.summary, 'No episode number in the file name');
  assert.equal(gag.at, Date.parse('2026-10-16T09:30:01')); assert.equal(gag.since, Date.parse('2026-10-16T09:00:01'));
  assert.equal(narcos.type, 'show');
  assert.equal(start.at, Date.parse('2026-10-16T08:00:02'));
});

test('folder clean-up after a skip is noted on that skip, and library roots shorten paths', () => {
  const lines = [
    at('13:35:50', '[MOVIE] Found: Kraven The Hunter (2024) [1080p] [WEBRip]'),
    at('13:35:50', 'SKIP: Destination already has the movie: /mnt/media/Movies/Kraven the Hunter (2024)'),
    at('13:35:50', 'Deleted source folder: Kraven The Hunter (2024) [1080p] [WEBRip]'),
  ];
  const [skip] = organizerActivity(lines, opts);
  assert.equal(skip.kind, 'skip'); assert.equal(skip.title, 'Kraven the Hunter (2024)'); assert.equal(skip.summary, 'Already in the library');
  assert.deepEqual(skip.notes, ['Source folder deleted']);
  // Library roots come from the configured folders; a list of file paths must never be mistaken for roots.
  const moved = [at('03:06:52', 'Moved -> /mnt/media/Movies/Runner Runner (2013)/Runner Runner (2013).mp4')];
  const withRoots = organizerActivity(moved, { sourceDir: '/mnt/media/Share', libraryRoots: ['/mnt/media/Movies/'] })[0];
  assert.equal(withRoots.title, 'Runner Runner (2013)'); assert.equal(withRoots.items[0].to, 'Movies/Runner Runner (2013)/Runner Runner (2013).mp4');
  const withFiles = organizerActivity(moved, { sourceDir: '/mnt/media/Share', libraryRoots: ['/mnt/media/Movies/Runner Runner (2013)/Runner Runner (2013).mp4'] })[0];
  assert.equal(withFiles.title, 'Runner Runner (2013)');
});
