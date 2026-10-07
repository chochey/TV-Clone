const { test } = require('node:test');const assert = require('node:assert/strict');
const {createDownloadStatus,createDownloadStatusWithVisibility}=require('./download-status');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {createDownloadImportReceipts}=require('./download-import-receipts');
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

async function importedPack(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'download-status-'));
 t.after(() => fs.rm(root, {recursive:true, force:true}));
 const sourceDir = path.join(root, 'Share');
 const release = 'Rick.and.Morty.S09.Complete.1080p.HEVC-PSA';
 const source = path.join(sourceDir, release);
 const targets = [1,2].map(ep => path.join(root, 'TV', `Rick and Morty - S09E0${ep}.mkv`));
 await fs.mkdir(sourceDir); await fs.mkdir(path.join(root,'TV'));
 for (const target of targets) await fs.writeFile(target,'episode');
 const logs = targets.flatMap((target,i) => [
  `[2026-09-22 12:00:00] Import source: ${path.join(source,`Rick.and.Morty.S09E0${i+1}.mkv`)} -> ${target}`,
  `[2026-09-22 12:00:00] Moved -> ${target}`,
 ]);
 const library = targets.map(_filePath => ({_filePath}));
 const torrent = {hash:'pack', name:'Rick and Morty S09 Complete 1080p HEVC-PSA',
  content_path:source, progress:1, added_on:at-60, state:'stoppedUP'};
 const options = {sourceDir};
 return {root,sourceDir,source,targets,logs,library,torrent,options,
  check:(extra={}) => createDownloadStatusWithVisibility(logs,library,{...options,...extra})(torrent)};
}

test('a fully imported season pack with every indexed physical episode and absent source can hide', async t => {
 const f = await importedPack(t);
 assert.equal((await f.check()).readyToHide,true);
 assert.equal((await fs.readdir(path.join(f.root,'TV'))).length,2,'confirmation never removes media');
});

test('small advertising leftovers and empty nested folders can hide without changing files', async t => {
 const f = await importedPack(t);
 await fs.mkdir(path.join(f.source,'empty'),{recursive:true});
 await fs.writeFile(path.join(f.source,'WWW.YIFY-TORRENTS.COM.jpg'),'advert');
 await fs.writeFile(path.join(f.source,'readme.nfo'),'readme');
 assert.equal((await f.check()).readyToHide,true);
 assert.deepEqual((await fs.readdir(f.source)).sort(),['WWW.YIFY-TORRENTS.COM.jpg','empty','readme.nfo']);
});

test('one imported episode does not hide a pack with remaining video, subtitles, parts, or unknown files', async t => {
 const f = await importedPack(t); await fs.mkdir(f.source);
 for (const name of ['S09E03.mkv','English.srt','S09E03.mkv.!qB','unknown.bin','music.mp3']) {
  const remaining=path.join(f.source,name); await fs.writeFile(remaining,'keep');
  const status=await f.check();
  assert.equal(status.label,'Imported files available');
  assert.equal(status.readyToHide,false,name);
  assert.equal(await fs.readFile(remaining,'utf8'),'keep');
  await fs.unlink(remaining);
 }
});

test('all imported episodes must be indexed and physically present before hiding', async t => {
 const f=await importedPack(t);
 const status=createDownloadStatusWithVisibility(f.logs,f.library.slice(0,1),f.options);
 assert.equal((await status(f.torrent)).readyToHide,false);
 await fs.unlink(f.targets[1]);
 assert.equal((await f.check()).readyToHide,false,'cached library entry does not replace physical proof');
});

test('a historical move or earlier timestamp cannot complete a new import attempt', async t => {
 const f=await importedPack(t);
 for (const logs of [
  [f.logs[1],f.logs[0]],
  [f.logs[0],f.logs[1].replace('12:00:00','11:58:00')],
  [f.logs[0],f.logs[3]],
  [...f.logs,f.logs[0].replace('12:00:00','12:01:00')],
 ]) {
  assert.equal((await createDownloadStatusWithVisibility(logs,f.library,f.options)(f.torrent)).readyToHide,false);
 }
});

test('reviews, incomplete progress, moving, errors, and rechecks stay visible without disk walks', async t => {
 const f=await importedPack(t);
 const io={lstat:async()=>{throw new Error('must not inspect');},readdir:async()=>{throw new Error('must not inspect');}};
 for(const state of ['moving','error','missingFiles','checkingDL','checkingUP','checkingResumeData','metaDL','checkingSomethingNew','unknown','downloading']) {
  assert.equal((await createDownloadStatusWithVisibility(f.logs,f.library,{...f.options,io})({...f.torrent,state})).readyToHide,false,state);
 }
 assert.equal(await createDownloadStatusWithVisibility(f.logs,f.library,{...f.options,io})({...f.torrent,progress:.5}),null);
 const review='[2026-09-22 12:00:01] REVIEW: '+JSON.stringify({source:path.basename(f.source),reason:'Subtitle conflict; source retained'});
 const status=await createDownloadStatusWithVisibility([...f.logs,review],f.library,{...f.options,io})(f.torrent);
 assert.equal(status.label,'Needs review'); assert.equal(status.readyToHide,false);
 assert.equal((await createDownloadStatusWithVisibility(f.logs,f.library,{...f.options,io})({...f.torrent,reviewReason:'No media'})).readyToHide,false);
});

test('a successful retry supersedes only the old attempt for that exact episode source',async t=>{
 const f=await importedPack(t);
 const failed=f.logs[0].replace('12:00:00','11:59:30');
 assert.equal((await createDownloadStatusWithVisibility([failed,...f.logs],f.library,f.options)(f.torrent)).readyToHide,true);
 const failedOther=failed.replace('S09E01','S09E03');
 assert.equal((await createDownloadStatusWithVisibility([failedOther,...f.logs],f.library,f.options)(f.torrent)).readyToHide,false);
 const laterFailed=f.logs[0].replace('12:00:00','12:01:00');
 assert.equal((await createDownloadStatusWithVisibility([...f.logs,laterFailed],f.library,f.options)(f.torrent)).readyToHide,false);
});

test('only recognized complete downloader states are eligible to hide',async t=>{
 const f=await importedPack(t);
 for(const state of ['uploading','stalledUP','pausedUP','stoppedUP','queuedUP','forcedUP']) {
  assert.equal((await createDownloadStatusWithVisibility(f.logs,f.library,f.options)({...f.torrent,state})).readyToHide,true,state);
 }
 assert.equal((await createDownloadStatusWithVisibility(f.logs,f.library,f.options)({...f.torrent,state:undefined})).readyToHide,false);
});

test('unavailable or unreadable source root and degraded storage cannot prove a disappeared release',async t=>{
 const f=await importedPack(t);
 assert.equal((await f.check({sourceDir:path.join(f.root,'missing')})).readyToHide,false);
 const io={...fs,readdir:async file=>{if(file===f.sourceDir)throw Object.assign(new Error('EIO'),{code:'EIO'});return fs.readdir(file);}};
 assert.equal((await f.check({io})).readyToHide,false);
 assert.equal((await f.check({libraryDegraded:true})).readyToHide,false);
});

test('source and destination symlinks never establish a complete import',async t=>{
 const f=await importedPack(t);
 await fs.symlink(path.join(f.root,'TV'),f.source);
 assert.equal((await f.check()).readyToHide,false);
 await fs.unlink(f.source); await fs.mkdir(f.source);
 await fs.symlink(f.targets[0],path.join(f.source,'advert.jpg'));
 assert.equal((await f.check()).readyToHide,false);
 await fs.unlink(path.join(f.source,'advert.jpg'));
 await fs.unlink(f.targets[1]); await fs.symlink(f.targets[0],f.targets[1]);
 assert.equal((await f.check()).readyToHide,false);
});

test('only exact release sources inside Share are inspected, never arbitrary downloader paths',async t=>{
 const f=await importedPack(t); const seen=[];
 const io={...fs,lstat:async file=>{seen.push(file);return fs.lstat(file);}};
 const torrent={...f.torrent,name:path.basename(f.source),content_path:`/untrusted/private/${path.basename(f.source)}`};
 assert.equal((await createDownloadStatusWithVisibility(f.logs,f.library,{...f.options,io})(torrent)).readyToHide,true);
 assert.ok(seen.every(file=>file.startsWith(f.root)),JSON.stringify(seen));
 const unrelated={...f.torrent,name:path.basename(f.source)+'.other',content_path:''};
 assert.equal((await createDownloadStatusWithVisibility(f.logs,f.library,f.options)(unrelated)).readyToHide,false);
 const outside=f.logs.map(line=>line.replace(f.sourceDir,path.join(f.root,'Other')));
 assert.equal((await createDownloadStatusWithVisibility(outside,f.library,f.options)(f.torrent)).readyToHide,false);
 const nested=f.logs.map(line=>line.replace(f.source,`${f.source}/nested/${path.basename(f.source)}`));
 assert.equal((await createDownloadStatusWithVisibility(nested,f.library,f.options)({...f.torrent,name:'nested',content_path:''})).readyToHide,false);
});

test('walk counts, file sizes, and timeouts are conservative',async t=>{
 const f=await importedPack(t); await fs.mkdir(f.source);
 await fs.writeFile(path.join(f.source,'large.jpg'),Buffer.alloc(1024*1024+1));
 assert.equal((await f.check()).readyToHide,false);
 await fs.unlink(path.join(f.source,'large.jpg'));
 const io={...fs,readdir:async file=>file===f.source?Array.from({length:257},(_,i)=>`${i}.txt`):fs.readdir(file)};
 assert.equal((await f.check({io})).readyToHide,false);
 assert.equal((await f.check({timeoutMs:10,io:{lstat:()=>new Promise(()=>{})}})).readyToHide,false);
});

test('simultaneous household refreshes share the bounded disk proof in one status snapshot',async t=>{
 const f=await importedPack(t); let rootReads=0;
 const io={...fs,readdir:async file=>{if(file===f.sourceDir)rootReads++;return fs.readdir(file);}};
 const status=createDownloadStatusWithVisibility(f.logs,f.library,{...f.options,io});
 const rows=await Promise.all(Array.from({length:10},()=>status(f.torrent)));
 assert.ok(rows.every(row=>row.readyToHide)); assert.equal(rootReads,1);
});

test('redownload invalidates both its receipt and the shared five-second disk proof',async t=>{
 const f=await importedPack(t);
 const status=createDownloadStatusWithVisibility(f.logs,f.library,f.options);
 const receipts=createDownloadImportReceipts();
 const options={statusFor:status.current,confirmStatus:status};
 assert.equal((await receipts.decorate([f.torrent],options))[0].importStatus.readyToHide,true);
 await fs.mkdir(f.source);await fs.writeFile(path.join(f.source,'Rick.and.Morty.S09E01.mkv'),'redownloaded episode');
 await receipts.decorate([{...f.torrent,progress:.4,state:'downloading'}],options);
 assert.equal((await receipts.decorate([f.torrent],options))[0].importStatus.readyToHide,false);
});
