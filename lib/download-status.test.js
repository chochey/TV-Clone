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
