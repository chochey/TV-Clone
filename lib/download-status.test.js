const { test } = require('node:test');const assert = require('node:assert/strict');
const {createDownloadStatus}=require('./download-status');
const at=Date.parse('2026-09-22T12:00:00')/1000;
const torrent={name:'Show.pack',progress:1,added_on:at-60};
const lines=['[2026-09-22 12:00:00] Import source: /mnt/media/Share/Show.pack/show.mkv -> /mnt/media/TV/show.mkv','[2026-09-22 12:00:00] Moved -> /mnt/media/TV/show.mkv'];
test('requires explicit completed move and library entry before reporting available',()=>{
 assert.match(createDownloadStatus(lines,[{_filePath:'/mnt/media/TV/show.mkv'}])(torrent).label,/available/);
 assert.match(createDownloadStatus(lines,[])(torrent).label,/scan pending/);
 assert.match(createDownloadStatus(lines.slice(0,1),[])(torrent).label,/not confirmed/);
});
test('old history cannot mark a newly re-downloaded torrent imported',()=>{
 assert.match(createDownloadStatus(lines,[{_filePath:'/mnt/media/TV/show.mkv'}])({...torrent,added_on:at+60}).label,/not confirmed/);
});
test('review takes precedence over partial import success',()=>{
 const review='[2026-09-22 12:00:00] REVIEW: '+JSON.stringify({source:'Show.pack',reason:'episode numbering unclear'});
 assert.equal(createDownloadStatus([...lines,review],[{_filePath:'/mnt/media/TV/show.mkv'}])(torrent).label,'Needs review');
});
test('file move state takes precedence over stale organizer review',()=>{
 const status=createDownloadStatus([],[]);
 assert.equal(status({name:'Pack',progress:1,state:'moving'}).label,'Waiting for file move');
});

const ironManSource = 'Iron Man [1080p]';
const ironManDestination = '/mnt/media/Movies/Iron Man (2008)/Iron Man (2008).mp4';
const ironManFailedAt = Date.parse('2026-10-03T22:10:58') / 1000;
const ironManTorrent = { name: ironManSource, progress: 1, added_on: ironManFailedAt - 60 };
const ironManFailure = [
 '[2026-10-03 22:10:58] [MOVIE] Found: Iron Man [1080p]',
 "[2026-10-03 22:10:58]   Parsed: title='Iron Man', year=none",
 '[2026-10-03 22:10:58] SKIP: No confident OMDb match for: Iron Man (no year)',
];
const ironManMatch = [
 '[2026-10-03 22:12:00] [MOVIE] Found: Iron Man [1080p]',
 "[2026-10-03 22:12:00]   Parsed: title='Iron Man', year=2008",
 '[2026-10-03 22:12:00]   OMDb match: Iron Man (2008)',
];
const ironManImport = [
 `[2026-10-03 22:12:01] Import source: /mnt/media/Share/${ironManSource}/Iron.Man.2008.1080p.BrRip.x264.YIFY.mp4 -> ${ironManDestination}`,
 `[2026-10-03 22:12:01] Moved -> ${ironManDestination}`,
];
const ironManLibrary = [{ _filePath: ironManDestination }];

test('the real recent Iron Man missing-year failure appears as Needs review', () => {
 const status = createDownloadStatus(ironManFailure, [])(ironManTorrent);
 assert.equal(status.label, 'Needs review');
 assert.equal(status.detail, 'No confident OMDb match');
});

test('a later resolved lookup and completed import replace the old failure status', () => {
 const logs = [...ironManFailure, ...ironManMatch, ...ironManImport];
 assert.equal(createDownloadStatus(logs, ironManLibrary)(ironManTorrent).label, 'Imported files available');
 assert.equal(createDownloadStatus(logs, [])(ironManTorrent).label, 'Imported — library scan pending');
 // Matching metadata alone does not prove that a move finished.
 assert.equal(createDownloadStatus([...ironManFailure, ...ironManMatch], ironManLibrary)(ironManTorrent).label,
  'Downloaded — import not confirmed');
});

test('a lookup failure before this torrent was added cannot classify the new download', () => {
 const status = createDownloadStatus(ironManFailure, [])({ ...ironManTorrent, added_on: ironManFailedAt + 1 });
 assert.equal(status.label, 'Downloaded — import not confirmed');
});

test('lookup failures match exact release names or content folders rather than title prefixes', () => {
 const status = createDownloadStatus(ironManFailure, []);
 for (const name of ['Iron Man', `${ironManSource}.extended`, ironManSource.toLowerCase(), 'Iron Man 2 [1080p]']) {
  assert.equal(status({ ...ironManTorrent, name }).label, 'Downloaded — import not confirmed', name);
 }
 assert.equal(status({ ...ironManTorrent, name: 'Downloader display name',
  content_path: `/mnt/media/Share/${ironManSource}` }).label, 'Needs review');
});

test('a newer completed import suppresses older unresolved lookup history even without its match line', () => {
 const logs = [...ironManFailure, ...ironManImport];
 assert.equal(createDownloadStatus(logs, ironManLibrary)(ironManTorrent).label, 'Imported files available');
 assert.equal(createDownloadStatus(logs, [])(ironManTorrent).label, 'Imported — library scan pending');
});

test('a newer lookup failure remains actionable after an earlier import record', () => {
 const laterFailure = ironManFailure.map(line => line.replace('22:10:58', '22:13:00'));
 assert.equal(createDownloadStatus([...ironManImport, ...laterFailure], ironManLibrary)(ironManTorrent).label,
  'Needs review');
});

test('an unresolved manual partial review still wins after a resolved lookup and imported video', () => {
 const reason = 'Subtitle destination already exists: Iron.Man.2008.srt; source retained for comparison';
 const review = '[2026-10-03 22:12:02] REVIEW: ' + JSON.stringify({
  type: 'movie', title: 'Iron Man', source: ironManSource, reason,
 });
 const logs = [...ironManFailure, ...ironManMatch, review, ...ironManImport];
 const status = createDownloadStatus(logs, ironManLibrary)(ironManTorrent);
 assert.equal(status.label, 'Needs review');
 assert.equal(status.detail, reason);
});

test('downloader move and incomplete download states retain precedence over a lookup failure', () => {
 const status = createDownloadStatus(ironManFailure, []);
 assert.equal(status({ ...ironManTorrent, state: 'moving' }).label, 'Waiting for file move');
 assert.equal(status({ ...ironManTorrent, progress: 0.5 }), null);
});

test('untimestamped or source-less title failures cannot prove this download needs review', () => {
 const unprovedLogs = [ironManFailure.map(line => line.replace(/^\[[^\]]+\] /, '')), ironManFailure.slice(-1)];
 for (const logs of unprovedLogs) {
  assert.equal(createDownloadStatus(logs, [])(ironManTorrent).label, 'Downloaded — import not confirmed');
 }
 assert.equal(createDownloadStatus(ironManFailure, [])({ name: ironManSource, progress: 1 }).label,
  'Downloaded — import not confirmed');
});
