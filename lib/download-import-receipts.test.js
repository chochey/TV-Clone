const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createDownloadImportReceipts}=require('./download-import-receipts');
const torrent={hash:'pack',added_on:1234,name:'Show pack',progress:1,state:'stoppedUP'};
const imported={label:'Imported files available',readyToHide:false};
const unknown={label:'Downloaded — import not confirmed',readyToHide:false};

function fixture(initial={}) {
 const saved=[]; let checks=0;
 const store=createDownloadImportReceipts({initial,save:async data=>saved.push(structuredClone(data)),now:()=>9999});
 const options={statusFor:()=>imported,confirmStatus:async()=>{checks++;return {...imported,readyToHide:true};}};
 return {store,saved,options,get checks(){return checks;}};
}

test('full proof records a bounded path-free receipt for this hash and download generation',async()=>{
 const f=fixture(); const rows=await f.store.decorate([torrent],f.options);
 assert.equal(rows[0].importStatus.readyToHide,true); assert.equal(f.checks,1);
 assert.deepEqual(f.saved,[{version:1,entries:[{hash:'pack',addedOn:1234,confirmedAt:9999}]}]);
 assert.equal(torrent.importStatus,undefined,'does not mutate downloader snapshot');
});

test('confirmation survives log rotation, media conversion, and server restart without new disk proof',async()=>{
 const f=fixture(); await f.store.decorate([torrent],f.options);
 const restarted=fixture(f.saved[0]);
 const rows=await restarted.store.decorate([torrent],{...restarted.options,statusFor:()=>unknown});
 assert.equal(rows[0].importStatus.readyToHide,true); assert.equal(rows[0].importStatus.label,'Imported files available');
 assert.equal(restarted.checks,0); assert.equal(restarted.saved.length,0);
});

test('current reviews, errors, moving, checking, or incomplete states override historical receipts',async()=>{
 const f=fixture(); await f.store.decorate([torrent],f.options);
 for(const state of ['moving','error','missingFiles','checkingDL','checkingUP','checkingResumeData','metaDL','checkingNew','unknown']) {
  const row=(await f.store.decorate([{...torrent,state}],f.options))[0];
  assert.equal(row.importStatus.readyToHide,false,state);
 }
 const review=(await f.store.decorate([torrent],{...f.options,statusFor:()=>({label:'Needs review',readyToHide:false})}))[0];
 assert.equal(review.importStatus.readyToHide,false);
 const noMedia=(await f.store.decorate([torrent],{...f.options,reviewFor:()=> 'No recognized video'}))[0];
 assert.equal(noMedia.importStatus.readyToHide,false);
 assert.equal(f.checks,1,'overridden receipts never rewalk the source');
 const incomplete=(await f.store.decorate([{...torrent,progress:.4}],{...f.options,statusFor:()=>null}))[0];
 assert.equal(incomplete.importStatus,null);
 assert.equal((await f.store.decorate([torrent],f.options))[0].importStatus.readyToHide,true);
 assert.equal(f.checks,2,'a completed redownload requires a new full proof');
});

test('a current manual review invalidates its receipt and cannot disappear after that review log rotates',async()=>{
 const f=fixture();await f.store.decorate([torrent],f.options);
 await f.store.decorate([torrent],{...f.options,statusFor:()=>({label:'Needs review',readyToHide:false})});
 const row=(await f.store.decorate([torrent],{statusFor:()=>unknown,confirmStatus:async()=>unknown}))[0];
 assert.equal(row.importStatus.readyToHide,false);
 assert.deepEqual(f.saved.at(-1).entries,[]);
});

test('redownloading the same hash and added_on invalidates its receipt before becoming complete again',async()=>{
 const f=fixture();await f.store.decorate([torrent],f.options);
 await f.store.decorate([{...torrent,progress:.4,state:'downloading'}],{...f.options,statusFor:()=>null});
 const row=(await f.store.decorate([torrent],{statusFor:()=>unknown,confirmStatus:async()=>unknown}))[0];
 assert.equal(row.importStatus.readyToHide,false,'remaining new media must not inherit old import proof');
 assert.deepEqual(f.saved.at(-1).entries,[]);
});

test('a re-added download with the same hash cannot inherit a previous generation receipt',async()=>{
 const f=fixture(); await f.store.decorate([torrent],f.options);
 const rows=await f.store.decorate([{...torrent,added_on:2000}],{statusFor:()=>unknown,confirmStatus:async()=>unknown});
 assert.equal(rows[0].importStatus.readyToHide,false); assert.deepEqual(f.saved.at(-1).entries,[]);
});

test('only a successful full snapshot prunes absent downloads; invalid snapshots preserve receipts',async()=>{
 const f=fixture(); await f.store.decorate([torrent],f.options);
 await assert.rejects(f.store.decorate(null,f.options),/Invalid download snapshot/);
 assert.equal((await f.store.decorate([torrent],f.options))[0].importStatus.readyToHide,true);
 await f.store.decorate([],f.options); assert.deepEqual(f.saved.at(-1).entries,[]);
});

test('failed full-import proof and missing generation identity never create historical receipts',async()=>{
 const f=fixture();
 await f.store.decorate([torrent],{statusFor:()=>imported,confirmStatus:async()=>imported});
 await f.store.decorate([{...torrent,added_on:0},{...torrent,hash:''}],f.options);
 assert.equal(f.saved.length,0);
});

test('proof finishing after a newer snapshot removed the torrent cannot recreate its receipt',async()=>{
 const f=fixture(); let release;
 const pending=f.store.decorate([torrent],{statusFor:()=>imported,confirmStatus:()=>new Promise(resolve=>{release=resolve;})});
 await f.store.decorate([],f.options);
 release({...imported,readyToHide:true}); await pending;
 assert.equal(f.saved.length,0);
});

test('a newer incomplete or reviewed snapshot invalidates an older in-flight proof of the same generation',async()=>{
 for (const newer of [
  {torrent:{...torrent,progress:.4,state:'downloading'},status:null},
  {torrent,status:{label:'Needs review',readyToHide:false}},
 ]) {
  const f=fixture();let release;
  const pending=f.store.decorate([torrent],{statusFor:()=>imported,confirmStatus:()=>new Promise(resolve=>{release=resolve;})});
  await f.store.decorate([newer.torrent],{statusFor:()=>newer.status,confirmStatus:async()=>unknown});
  release({...imported,readyToHide:true});
  assert.equal((await pending)[0].importStatus.readyToHide,false);
  assert.equal((await f.store.decorate([torrent],{statusFor:()=>unknown,confirmStatus:async()=>unknown}))[0].importStatus.readyToHide,false);
  assert.equal(f.saved.length,0);
 }
});

test('corrupt records are ignored and receipt storage stays bounded',async()=>{
 assert.doesNotThrow(()=>createDownloadImportReceipts({initial:null}));
 const saved=[];const store=createDownloadImportReceipts({initial:{entries:[null,{},'bad']},limit:2,
  save:async data=>saved.push(data),now:()=>9999});
 const torrents=[1,2,3].map(n=>({...torrent,hash:String(n)}));
 await store.decorate(torrents,{statusFor:()=>imported,confirmStatus:async()=>({...imported,readyToHide:true})});
 assert.equal(saved.at(-1).entries.length,2);
});

test('server receipt wiring uses strict persistence and both authenticated list route and background watcher',()=>{
 const fs=require('fs');const path=require('path');
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const cache=source.slice(source.indexOf('const DOWNLOAD_IMPORT_RECEIPTS_FILE'),source.indexOf('// qBittorrent status'));
 assert.match(cache,/save: data => saveJSONStrict\(DOWNLOAD_IMPORT_RECEIPTS_FILE, data\)/);
 const route=source.slice(source.indexOf("app.get('/api/qbt/torrents',"),source.indexOf('// ── Server-side download watcher (lib/download-watcher.js)'));
 assert.match(route,/requirePermission\('canDownload'\), requireQbt/);
 assert.match(route,/res\.json\(await downloadsWithStatus\(torrents\)\)/);
 const watcher=fs.readFileSync(path.join(__dirname,'download-watcher.js'),'utf8');
 assert.match(watcher,/await downloadsWithStatus\(torrents\)/);
 assert.equal((route+watcher).includes("qbt('POST'"),false,'auto visibility makes no downloader changes');
});

test('failed bookkeeping saves retry on a later successful snapshot',async()=>{
 let saves=0;const store=createDownloadImportReceipts({save:async()=>{if(++saves===1)throw new Error('unavailable');}});
 const options={statusFor:()=>imported,confirmStatus:async()=>({...imported,readyToHide:true})};
 await store.decorate([torrent],options);await store.decorate([torrent],options);assert.equal(saves,2);
});
