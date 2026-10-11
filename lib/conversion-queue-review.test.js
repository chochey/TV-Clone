const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const createQueue=require('./conversion-queue');
const createReview=require('./conversion-review');
const {fileFingerprint}=createQueue;
const {saveJSONStrict,loadJSON}=require('./json-store');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate) {
  const deadline=Date.now()+15000;
  while(!predicate()) {if(Date.now()>deadline)throw Error('Queue did not reach expected state');await new Promise(resolve=>setTimeout(resolve,5));}
}
async function fixture(t,count=2) {
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'conversion-queue-review-'));
  t.after(()=>fs.promises.rm(dir,{recursive:true,force:true}));
  const files=Array.from({length:count},(_,i)=>path.join(dir,`episode-${i}.avi`));
  await Promise.all(files.map((file,i)=>fs.promises.writeFile(file,`source episode ${i}`)));
  const stateFile=path.join(dir,'queue.json'),reviewFile=path.join(dir,'reviews.json');
  const eligible=new Set(files),calls=[],config={enabled:true,retainOriginals:false,pauseWhilePlaying:false,schedule:{start:'',end:''},maxFilesPerRun:1};
  const review=over=>createReview({file:reviewFile,save:saveJSONStrict,...over});
  const queue=(r,over={})=>createQueue({review:r,
    worker:{convertCompatible:async file=>{calls.push(file);return {ok:true};},killActive:()=>false,...over.worker},
    getConfig:()=>config,getEligibleFiles:()=>[...eligible],getMediaId:file=>path.basename(file),isPlaybackActive:()=>false,
    loadState:()=>loadJSON(stateFile,null),saveState:data=>saveJSONStrict(stateFile,data),...over});
  const entry=async file=>({filePath:file,mediaId:path.basename(file),fingerprint:await fileFingerprint(file)});
  return {dir,files,stateFile,reviewFile,eligible,calls,config,review,queue,entry};
}
test('review suppression survives restart and bounded history eviction beyond 200 failures',async t=>{
  const f=await fixture(t,230),r=f.review();
  const q=f.queue(r,{worker:{convertCompatible:async file=>{f.calls.push(file);return {ok:false,reason:'Needs review: source parser error; original retained'};},killActive:()=>false}});
  await q.start({all:true});await until(()=>q.status==='idle');
  assert.equal(q.snapshot().failed,230);assert.equal(q.snapshot().history.length,60);
  assert.equal(loadJSON(f.stateFile,null).history.length,200);assert.equal((await r.snapshot()).total,230);
  const cold=f.review(),reboot=f.queue(cold);f.calls.length=0;
  const start=await reboot.start({all:true});assert.equal(start.ok,false);assert.equal(start.suppressed,230);
  assert.equal(reboot.snapshot().reviewSuppressed,230);assert.equal(reboot.status,'idle');assert.deepEqual(f.calls,[]);
  assert.equal((await cold.snapshot({offset:200})).entries.length,30,'oldest holds remain accessible after history eviction');
});
test('new batches fill their limit from unreviewed files and changed replacements become eligible automatically',async t=>{
  const f=await fixture(t),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'Header missing'});
  const q=f.queue(r);const first=await q.start();assert.equal(first.ok,true);assert.equal(first.queued,1);assert.equal(first.suppressed,1);
  await until(()=>q.status==='idle');assert.deepEqual(f.calls,[f.files[1]]);
  await fs.promises.writeFile(f.files[0],'a freshly supplied replacement source');f.calls.length=0;
  assert.equal((await q.start()).ok,true);await until(()=>q.status==='idle');assert.deepEqual(f.calls,[f.files[0]]);
  assert.equal((await r.snapshot()).total,0,'a verified changed replacement retires its captured stale review');
});
test('a failed changed replacement records its new identity instead of retiring the review on the captured token',async t=>{
  const f=await fixture(t,1),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'old damaged source'});
  const oldId=(await r.snapshot()).entries[0].id;await fs.promises.writeFile(f.files[0],'replacement source');
  const q=f.queue(r,{worker:{convertCompatible:async()=>({ok:false,reason:'replacement decode error'}),killActive:()=>false}});
  await q.start();await until(()=>q.status==='idle');const next=(await r.snapshot()).entries[0];
  assert.equal(q.snapshot().failed,1);assert.notEqual(next.id,oldId);assert.equal(r.isBlocked(await f.entry(f.files[0])),true);
});
test('successful queue work cannot retire a concurrently recorded later replacement review',async t=>{
  const f=await fixture(t,1),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'old damaged source'});
  await fs.promises.writeFile(f.files[0],'first replacement');let entered,finish;
  const q=f.queue(r,{worker:{convertCompatible:async()=>{entered=true;await new Promise(resolve=>finish=resolve);return {ok:true};},killActive:()=>false}});
  await q.start();await until(()=>!!entered);
  await fs.promises.writeFile(f.files[0],'later concurrent replacement');const later=await f.entry(f.files[0]);await r.record(later,{ok:false,reason:'later source failed'});
  finish();await until(()=>q.status==='idle');assert.equal(r.isBlocked(later),true);assert.equal((await r.snapshot()).total,1);
});
test('a captured prior-review token survives valid interrupted-run hydration and clears the stale row on success',async t=>{
  const f=await fixture(t,1),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'old decode error'});
  const id=(await r.snapshot()).entries[0].id;await fs.promises.writeFile(f.files[0],'valid replacement source');
  f.config.pauseWhilePlaying=true;const q=f.queue(r,{isPlaybackActive:()=>true});await q.start();await q.pause();
  const saved=loadJSON(f.stateFile,null);assert.equal(saved.run.queue[0].priorReviewId,id);await q.stop();await until(()=>q.status==='idle');
  f.config.pauseWhilePlaying=false;const cold=f.review(),recovered=f.queue(cold,{loadState:()=>saved});assert.equal((await recovered.resume()).ok,true);
  await until(()=>recovered.status==='idle');assert.equal((await cold.snapshot()).total,0);assert.deepEqual(f.calls,[f.files[0]]);
});
test('malformed prior-review tokens in a saved run cannot release old review evidence',async t=>{
  const f=await fixture(t,1),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'old decode error'});
  await fs.promises.writeFile(f.files[0],'valid replacement source');const entry=await f.entry(f.files[0]);
  const saved={version:1,reviewInitialized:true,run:{id:'saved',status:'running',scope:'all',queue:[{...entry,priorReviewId:'invalid-token'}],cursor:0,startedAt:1,
    converted:0,failed:0,skipped:0,bytesBefore:0,bytesAfter:0,results:[]},history:[],runs:[]};
  const q=f.queue(r,{loadState:()=>saved});await q.resume();await until(()=>q.status==='idle');assert.equal((await r.snapshot()).total,1);
});
test('retry is one selected file, retains its hold through another failure, and clears it only on success',async t=>{
  const f=await fixture(t),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'incomplete frame'},{at:1000});
  const row=(await r.snapshot()).entries[0];let succeeds=false;
  const q=f.queue(r,{worker:{convertCompatible:async file=>{f.calls.push(file);assert.equal((await r.snapshot()).total,1);
    return succeeds?{ok:true}:{ok:false,reason:'incomplete frame again'};},killActive:()=>false}});
  assert.equal((await q.retryReview(row.id)).ok,true);await until(()=>q.status==='idle');
  assert.equal(q.snapshot().scope,'retry');assert.equal(q.snapshot().total,1);assert.deepEqual(f.calls,[f.files[0]]);
  assert.equal((await r.get(row.id)).attempts,2);assert.equal((await r.get(row.id)).firstFailedAt,1000);
  succeeds=true;assert.equal((await q.retryReview(row.id)).ok,true);await until(()=>q.status==='idle');
  assert.equal((await r.snapshot()).total,0);assert.deepEqual(f.calls,[f.files[0],f.files[0]]);
});
test('retry checkpoint durability is awaited and concurrent Start/Retry cannot create duplicate workers',async t=>{
  const f=await fixture(t),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'Header missing'});
  const row=(await r.snapshot()).entries[0];let release,gate=true,finish,active=0,maxActive=0;
  const q=f.queue(r,{saveState:async data=>{if(gate&&data.run.scope==='retry'){gate=false;await new Promise(resolve=>release=resolve);}await saveJSONStrict(f.stateFile,data);},
    worker:{convertCompatible:async file=>{f.calls.push(file);active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>finish=resolve);active--;return {ok:false,reason:'Header missing'};},killActive:()=>false}});
  const retry=q.retryReview(row.id);await until(()=>!!release);assert.deepEqual(f.calls,[]);assert.equal((await r.snapshot()).total,1);
  assert.equal((await q.retryReview(row.id)).ok,false);assert.equal((await q.start()).ok,false);
  release();assert.equal((await retry).ok,true);await until(()=>!!finish);
  assert.equal((await q.retryReview(row.id)).ok,false);finish();await until(()=>q.status==='idle');assert.equal(maxActive,1);
});
test('retry rejects disabled, absent, no-longer-eligible, changed and noncanonical sources',async t=>{
  const f=await fixture(t,1),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'decode error'});
  const row=(await r.snapshot()).entries[0],q=f.queue(r);
  f.config.enabled=false;assert.match((await q.retryReview(row.id)).error,/Enable conversion/);f.config.enabled=true;
  assert.match((await q.retryReview('bad')).error,/Invalid review/);assert.match((await q.retryReview('a'.repeat(32))).error,/not found/);
  f.eligible.clear();assert.match((await q.retryReview(row.id)).error,/no longer eligible/);f.eligible.add(f.files[0]);
  const alias=f.queue(r,{getRealPath:async()=>path.join(f.dir,'different.avi')});assert.match((await alias.retryReview(row.id)).error,/symbolic link/);
  await fs.promises.writeFile(f.files[0],'changed replacement');assert.match((await q.retryReview(row.id)).error,/source changed/);
  await fs.promises.unlink(f.files[0]);assert.match((await q.retryReview(row.id)).error,/missing/);assert.deepEqual(f.calls,[]);
});
test('retry rejects a real symbolic-link ancestor even when the regular file fingerprint is unchanged',async t=>{
  const f=await fixture(t,0),media=path.join(f.dir,'media'),moved=path.join(f.dir,'moved');
  await fs.promises.mkdir(media);const source=path.join(media,'source.avi');await fs.promises.writeFile(source,'original source');f.eligible.add(source);
  const entry=await f.entry(source),r=f.review();await r.seed(null);await r.record(entry,{ok:false,reason:'decode error'});
  const id=(await r.snapshot()).entries[0].id;await fs.promises.rename(media,moved);await fs.promises.symlink(moved,media);
  assert.deepEqual(await fileFingerprint(source),entry.fingerprint);
  assert.match((await f.queue(r).retryReview(id)).error,/symbolic link/);assert.deepEqual(f.calls,[]);
});
test('Stop during a retry checkpoint cancels that one-time authorization and preserves its review hold',async t=>{
  const f=await fixture(t,1),r=f.review();await r.seed(null);const entry=await f.entry(f.files[0]);await r.record(entry,{ok:false,reason:'decode error'});
  const id=(await r.snapshot()).entries[0].id;let release,first=true;
  const q=f.queue(r,{saveState:async data=>{if(first&&data.run.scope==='retry'){first=false;await new Promise(resolve=>release=resolve);}await saveJSONStrict(f.stateFile,data);}});
  const retry=q.retryReview(id);await until(()=>!!release);const stopping=q.stop();release();
  assert.equal((await retry).ok,false);assert.equal((await stopping).ok,true);await until(()=>q.status==='idle');
  assert.deepEqual(f.calls,[]);assert.equal((await r.get(id)).attempts,1);assert.equal(r.isBlocked(entry),true);
  const reboot=f.queue(f.review());assert.equal(reboot.status,'idle');assert.equal((await reboot.resume()).ok,false);
});
test('missing or corrupt review state blocks Start, Resume and Retry without discarding the hold',async t=>{
  const f=await fixture(t),r=f.review();await r.seed(null);await r.record(await f.entry(f.files[0]),{ok:false,reason:'decode error'});
  const row=(await r.snapshot()).entries[0];let q=f.queue(r);await r.ready();
  await fs.promises.unlink(f.reviewFile);assert.equal((await q.start()).ok,false);assert.equal((await q.retryReview(row.id)).ok,false);assert.deepEqual(f.calls,[]);
  await fs.promises.writeFile(f.reviewFile,'{corrupt');q=f.queue(f.review());assert.equal((await q.start()).ok,false);
  const state={version:1,reviewInitialized:true,run:{id:'old',status:'running',scope:'all',queue:[await f.entry(f.files[1])],cursor:0,startedAt:1,
    converted:0,failed:0,skipped:0,bytesBefore:0,bytesAfter:0,results:[]},history:[],runs:[]};
  const recovered=f.queue(f.review(),{loadState:()=>state});assert.equal((await recovered.resume()).ok,false);assert.equal(recovered.status,'interrupted');assert.deepEqual(f.calls,[]);
});
test('an unexpectedly missing registry after reboot is never initialized empty from a saved marked queue',async t=>{
  const f=await fixture(t,1),r=f.review(),q=f.queue(r);await q.start();await until(()=>q.status==='idle');
  assert.equal(loadJSON(f.stateFile,null).reviewInitialized,true);await fs.promises.unlink(f.reviewFile);
  const reboot=f.queue(f.review());const start=await reboot.start();assert.equal(start.ok,false);assert.match(start.error,/review records/);
  assert.equal(fs.existsSync(f.reviewFile),false);
});
test('bootstrap establishes its durable fail-closed marker even before any new conversion run',async t=>{
  const f=await fixture(t,1),r=f.review();f.queue(r);
  await until(()=>fs.existsSync(f.reviewFile));await r.ready();
  assert.equal(loadJSON(f.stateFile,null).reviewInitialized,true);assert.deepEqual(f.calls,[]);
  await fs.promises.unlink(f.reviewFile);const reboot=f.queue(f.review());
  assert.equal((await reboot.start()).ok,false);assert.equal(fs.existsSync(f.reviewFile),false);assert.deepEqual(f.calls,[]);
});
test('bootstrap cannot create review state or touch a worker before its queue marker is durable',async t=>{
  const f=await fixture(t,1),r=f.review();let release,first=true;
  const q=f.queue(r,{saveState:async data=>{if(first){first=false;await new Promise(resolve=>release=resolve);}await saveJSONStrict(f.stateFile,data);}});
  await until(()=>!!release);assert.equal(fs.existsSync(f.reviewFile),false);assert.deepEqual(f.calls,[]);
  const starting=q.start();release();assert.equal((await starting).ok,true);await until(()=>q.status==='idle');
  assert.equal(loadJSON(f.stateFile,null).reviewInitialized,true);assert.equal(f.calls.length,1);
});
test('Stop during an interrupted-run bootstrap cannot erase its established review marker',async t=>{
  const f=await fixture(t,1),entry=await f.entry(f.files[0]);
  const saved={version:1,run:{id:'old',status:'running',scope:'all',queue:[entry],cursor:0,startedAt:1,
    converted:0,failed:0,skipped:0,bytesBefore:0,bytesAfter:0,results:[]},history:[],runs:[]};
  let release,first=true;
  const r=f.review(),q=f.queue(r,{loadState:()=>saved,saveState:async data=>{
    if(first){first=false;await new Promise(resolve=>release=resolve);}await saveJSONStrict(f.stateFile,data);
  }});
  await until(()=>!!release);const stopped=q.stop();release();await stopped;await until(()=>fs.existsSync(f.reviewFile));await q.flush();
  assert.equal(loadJSON(f.stateFile,null).reviewInitialized,true);assert.deepEqual(f.calls,[]);
  await fs.promises.unlink(f.reviewFile);assert.equal((await f.queue(f.review()).start()).ok,false);
});
test('a failed review write interrupts before cursor advancement or another source, preserving original files',async t=>{
  const f=await fixture(t),r=f.review();await r.seed(null);let broken=true;
  const guarded=f.review({save:async(file,data)=>{if(broken&&data.entries.length)throw Error('review disk full');await saveJSONStrict(file,data);}});
  const q=f.queue(guarded,{worker:{convertCompatible:async file=>{f.calls.push(file);return {ok:false,reason:'decode damage'};},killActive:()=>false}});
  await q.start({all:true});await until(()=>q.status==='interrupted');
  assert.equal(q.snapshot().done,0);assert.deepEqual(f.calls,[f.files[0]]);assert.equal((await guarded.snapshot()).total,0);
  assert.equal(await fs.promises.readFile(f.files[0],'utf8'),'source episode 0');
  broken=false;await q.stop();await until(()=>q.status==='idle');
});
test('recovery skips a durable review even when a crash preceded the corresponding queue cursor checkpoint',async t=>{
  const f=await fixture(t),r=f.review();await r.seed(null);const failedEntry=await f.entry(f.files[0]);await r.record(failedEntry,{ok:false,reason:'incomplete frame'});
  const saved={version:1,reviewInitialized:true,run:{id:'crashed',status:'running',scope:'all',queue:[failedEntry,await f.entry(f.files[1])],cursor:0,startedAt:1,
    converted:0,failed:0,skipped:0,bytesBefore:0,bytesAfter:0,results:[]},history:[],runs:[]};
  const q=f.queue(r,{loadState:()=>saved});assert.equal((await q.resume()).ok,true);await until(()=>q.status==='idle');
  assert.deepEqual(f.calls,[f.files[1]]);assert.equal(q.snapshot().skipped,1);assert.equal((await r.snapshot()).total,1);
});
test('a saved one-time retry needs manual Resume and never expands to other eligible files',async t=>{
  const f=await fixture(t),r=f.review();await r.seed(null);const entry=await f.entry(f.files[0]);await r.record(entry,{ok:false,reason:'decode error'});
  const id=(await r.snapshot()).entries[0].id;
  const saved={version:1,reviewInitialized:true,run:{id:'retry',status:'running',scope:'retry',queue:[{...entry,retryReviewId:id}],cursor:0,startedAt:1,
    converted:0,failed:0,skipped:0,bytesBefore:0,bytesAfter:0,results:[]},history:[],runs:[]};
  const q=f.queue(r,{loadState:()=>saved});await turn();assert.equal(q.status,'interrupted');assert.deepEqual(f.calls,[]);
  await q.resume();await until(()=>q.status==='idle');assert.deepEqual(f.calls,[f.files[0]]);assert.equal((await r.snapshot()).total,0);
});
