import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDownloads } from './download-list.js';
test('completed downloads leave the active list even if import history is unavailable', () => {
 const done = {hash:'done', progress:1, state:'stoppedUP', importStatus:{label:'Downloaded — import not confirmed'}};
 const downloading = {hash:'active', progress:.99, state:'downloading'};
 assert.deepEqual(splitDownloads([done,downloading]),{active:[downloading],completed:[done],imported:[]});
});
test('seeding downloads are completed while errors and reviews remain visible', () => {
 const seeding={progress:1,state:'uploading'};
 const review={progress:1,state:'stoppedUP',importStatus:{label:'Needs review'}};
 const missing={progress:1,state:'missingFiles'};
 assert.deepEqual(splitDownloads([seeding,review,missing]),{active:[review,missing],completed:[seeding],imported:[]});
});
test('a resumed incomplete download returns to the active list', () => {
 const torrent={progress:1,state:'stoppedUP'};
 assert.equal(splitDownloads([torrent]).completed.length,1);
 torrent.progress=.5;torrent.state='downloading';
 assert.equal(splitDownloads([torrent]).active.length,1);
});
test('a verified imported download leaves both active and completed lists', () => {
 const imported={hash:'imported',progress:1,state:'stoppedUP',importStatus:{label:'Imported files available',readyToHide:true}};
 assert.deepEqual(splitDownloads([imported]),{active:[],completed:[],imported:[imported]});
});
test('partial imports and scan-pending downloads remain visible until the server verifies completion', () => {
 const partial={progress:1,state:'stoppedUP',importStatus:{label:'Imported files available',readyToHide:false}};
 const pending={progress:1,state:'stoppedUP',importStatus:{label:'Imported — library scan pending'}};
 assert.deepEqual(splitDownloads([partial,pending]),{active:[],completed:[partial,pending],imported:[]});
});
test('an import receipt never hides a new error, review, move, recheck or incomplete download', () => {
 const base={progress:1,state:'stoppedUP',importStatus:{label:'Imported files available',readyToHide:true}};
 const rows=[...['moving','checkingDL','checkingUP','checkingResumeData','missingFiles','error'].map(state=>({...base,state})),
  {...base,reviewReason:'Subtitle conflict'}, {...base,importStatus:{label:'Needs review',readyToHide:true}}, {...base,progress:.5}];
 assert.deepEqual(splitDownloads(rows),{active:rows,completed:[],imported:[]});
});
