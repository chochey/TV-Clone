const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const createWorker=require('./conversion-worker');
async function fixture(t,options={}) {
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'conversion-preflight-'));
  t.after(()=>fs.promises.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'movie.mkv');await fs.promises.writeFile(file,'unchanged source');
  let storageCalls=0;
  const worker=createWorker({hashId:file=>file,probeCache:{},pixFmtCache:{},audioProbeCache:{},audioTracksCache:{},subProbeCache:{},heightCache:{},levelCache:{},
    markDirty(){},scheduleSaveMediaInfo(){},getActiveTranscodeFilePaths:()=>options.playing?new Set([file]):new Set(),
    getLimits:()=>({minFreeSpaceGB:0}),storage:{freeSpace:async()=>{storageCalls++;return options.drive || {known:true,available:1e12,mount:'/physical-a',label:'Drive A'};}}});
  return {dir,file,worker,storageCalls:()=>storageCalls};
}
test('streaming preflight defers without reading drive space or changing files',async t=>{
  const f=await fixture(t,{playing:true});const result=await f.worker.convertCompatible(f.file);
  assert.equal(result.deferred,true);assert.equal(result.code,'playback');assert.equal(f.storageCalls(),0);
  assert.equal(await fs.promises.readFile(f.file,'utf8'),'unchanged source');assert.deepEqual(await fs.promises.readdir(f.dir),['movie.mkv']);
});
test('known physical low space defers with required/available drive information',async t=>{
  const f=await fixture(t,{drive:{known:true,available:0,mount:'/physical-a',label:'Drive A'}});
  const result=await f.worker.convertCompatible(f.file);assert.equal(result.deferred,true);assert.equal(result.code,'storage');
  assert.equal(result.storage.mount,'/physical-a');assert.equal(result.storage.available,0);assert.ok(result.storage.required>0);
  assert.deepEqual(await fs.promises.readdir(f.dir),['movie.mkv']);
});
test('unknown physical space fails for review instead of retrying automatically',async t=>{
  const f=await fixture(t,{drive:{known:false}});const result=await f.worker.convertCompatible(f.file);
  assert.equal(result.ok,false);assert.notEqual(result.deferred,true);assert.match(result.reason,/Needs review/);
});
test('symbolic link sources fail before storage checks',async t=>{
  const f=await fixture(t);const link=path.join(f.dir,'alias.mkv');await fs.promises.symlink(f.file,link);
  const result=await f.worker.preflight(link);assert.equal(result.ok,false);assert.notEqual(result.deferred,true);
  assert.equal(f.storageCalls(),0);assert.equal(await fs.promises.readFile(f.file,'utf8'),'unchanged source');
});
test('regular sources with known sufficient physical space still pass',async t=>{
  const f=await fixture(t);const result=await f.worker.preflight(f.file);assert.equal(result.ok,true);assert.equal(result.size,16);
});
