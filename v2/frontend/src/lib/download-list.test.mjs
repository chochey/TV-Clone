import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDownloads } from './download-list.js';
test('completed downloads leave the active list even if import history is unavailable', () => {
 const done = {hash:'done', progress:1, state:'stoppedUP', importStatus:{label:'Downloaded — import not confirmed'}};
 const downloading = {hash:'active', progress:.99, state:'downloading'};
 assert.deepEqual(splitDownloads([done,downloading]),{active:[downloading],completed:[done]});
});
test('seeding downloads are completed while errors and reviews remain visible', () => {
 const seeding={progress:1,state:'uploading'};
 const review={progress:1,state:'stoppedUP',importStatus:{label:'Needs review'}};
 const missing={progress:1,state:'missingFiles'};
 assert.deepEqual(splitDownloads([seeding,review,missing]),{active:[review,missing],completed:[seeding]});
});
test('a resumed incomplete download returns to the active list', () => {
 const torrent={progress:1,state:'stoppedUP'};
 assert.equal(splitDownloads([torrent]).completed.length,1);
 torrent.progress=.5;torrent.state='downloading';
 assert.equal(splitDownloads([torrent]).active.length,1);
});
