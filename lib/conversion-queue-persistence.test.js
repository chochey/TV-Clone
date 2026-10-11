const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createQueue = require('./conversion-queue');
const {loadJSON,saveJSONStrict} = require('./json-store');

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const deadline=Date.now()+5000;
  while (!check()) {assert.ok(Date.now()<deadline,'queue reached expected state');await new Promise(resolve=>setTimeout(resolve,2));}
}
async function fixture(t,count=3) {
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'conversion-checkpoint-'));
  t.after(()=>fs.promises.rm(dir,{recursive:true,force:true}));
  const files=[];
  for (let i=0;i<count;i++) {const file=path.join(dir,`movie-${i}.mkv`);await fs.promises.writeFile(file,`source ${i}`);files.push(file);}
  const stateFile=path.join(dir,'queue.json'), calls=[],eligible=new Set(files);
  const config={enabled:true,retainOriginals:false,pauseWhilePlaying:false,schedule:{start:'',end:''},maxFilesPerRun:1};
  function queue(over={}) {
    return createQueue({worker:{convertCompatible:async file=>{calls.push(file);return {ok:true,originalDeleted:true,newPath:file+'.mp4',bytesBefore:8,bytesAfter:6};},killActive:()=>false,...over.worker},
      getConfig:()=>config,getEligibleFiles:()=>[...eligible],getMediaId:file=>path.basename(file),isPlaybackActive:()=>false,
      getRetainedBytes:()=>0,loadState:()=>loadJSON(stateFile,null),saveState:data=>saveJSONStrict(stateFile,data),
      ...over});
  }
  return {dir,files,stateFile,calls,eligible,config,queue,read:()=>loadJSON(stateFile,null)};
}

async function savedPaused(f) {
  const q=f.queue({isPlaybackActive:()=>true});f.config.pauseWhilePlaying=true;
  assert.equal((await q.start({all:true})).ok,true);await turn();assert.equal((await q.pause()).ok,true);
  const saved=f.read();await q.stop();f.config.pauseWhilePlaying=false;
  return saved;
}

test('strict checkpoint is awaited before any worker starts',async t=>{
  const f=await fixture(t,1);let release,first=true;
  const gate=new Promise(resolve=>release=resolve);
  const q=f.queue({saveState:async data=>{if(first){first=false;await gate;}await saveJSONStrict(f.stateFile,data);}});
  const starting=q.start({all:true});await turn();assert.deepEqual(f.calls,[]);
  release();assert.equal((await starting).ok,true);await until(()=>q.status==='idle');
  assert.equal(f.read().run.cursor,1);assert.equal(f.read().history[0].originalDeleted,true);
  assert.equal(f.read().history[0].mediaId,'movie-0.mkv');
});

test('reboot recovers original scope/cursor/history but waits for explicit Resume',async t=>{
  const f=await fixture(t);let first=true,q;
  q=f.queue({worker:{convertCompatible:async file=>{f.calls.push(file);if(first){first=false;await q.pause();}return {ok:true};},killActive:()=>false}});
  await q.start({all:true});await until(()=>q.snapshot().done===1);await q.flush();
  const saved=f.read();await q.stop();f.calls.length=0;
  const restored=f.queue({loadState:()=>saved});await turn();
  assert.equal(restored.status,'interrupted');assert.equal(restored.snapshot().scope,'all');
  assert.equal(restored.snapshot().done,1);assert.equal(restored.snapshot().history.length,1);assert.deepEqual(f.calls,[]);
  assert.match((await restored.start()).error,/Resume the interrupted/);
  assert.equal((await restored.resume()).ok,true);await until(()=>restored.status==='idle');
  assert.deepEqual(f.calls,f.files.slice(1));assert.equal(restored.snapshot().converted,3);
  const reboot=f.queue();assert.equal(reboot.status,'idle');assert.equal(reboot.snapshot().history.length,3);
  assert.equal(reboot.snapshot().runs[0].status,'complete');
  // A later run clears its own results while keeping durable prior outcomes.
  await reboot.start();await until(()=>reboot.status==='idle');assert.equal(reboot.snapshot().history.length,4);
});

test('explicit Stop remains terminal after reboot and cannot be silently resumed',async t=>{
  const f=await fixture(t);f.config.pauseWhilePlaying=true;
  const q=f.queue({isPlaybackActive:()=>true});await q.start({all:true});await turn();await q.stop();
  await until(()=>q.status==='idle');await q.flush();
  const restored=f.queue();assert.equal(restored.status,'idle');assert.equal(restored.snapshot().canResume,false);
  assert.equal((await restored.resume()).ok,false);assert.deepEqual(f.calls,[]);
  assert.equal(restored.snapshot().runs[0].status,'stopped');
});

test('Resume rejects changed/missing files and removed categories, without adding new candidates',async t=>{
  const f=await fixture(t,4),saved=await savedPaused(f);
  await fs.promises.writeFile(f.files[0],'replacement source has a different size');
  await fs.promises.unlink(f.files[1]);f.eligible.delete(f.files[2]);
  const added=path.join(f.dir,'new.mkv');await fs.promises.writeFile(added,'new');f.eligible.add(added);
  const q=f.queue({loadState:()=>saved});assert.equal((await q.resume()).ok,true);await until(()=>q.status==='idle');
  assert.deepEqual(f.calls,[f.files[3]]);assert.equal(q.snapshot().failed,2);assert.equal(q.snapshot().skipped,1);
  assert.equal(q.snapshot().total,4);assert.equal(q.snapshot().done,4);
  assert.match(q.snapshot().history.find(row=>row.filePath===f.files[0]).reason,/source changed/);
  assert.equal(await fs.promises.readFile(f.files[0],'utf8'),'replacement source has a different size');
});

test('saved Stop intent is terminal even if the old worker had not yet exited',async t=>{
  const f=await fixture(t,1);let finish;
  const q=f.queue({worker:{convertCompatible:()=>new Promise(resolve=>finish=resolve),killActive:()=>false}});
  await q.start();await until(()=>!!finish);await q.stop();
  assert.equal(f.read().run.status,'stopping');const restored=f.queue();
  assert.equal(restored.status,'idle');assert.equal((await restored.resume()).ok,false);
  finish({ok:false,reason:'cancelled'});await until(()=>q.status==='idle');assert.equal(q.snapshot().failed,0);
});

test('checkpoint write failure starts no work and requires an explicit recovery action',async t=>{
  const f=await fixture(t,1);let broken=true;
  const q=f.queue({saveState:async data=>{if(broken)throw Error('disk read-only');await saveJSONStrict(f.stateFile,data);}});
  assert.equal((await q.start()).ok,false);assert.equal(q.status,'interrupted');assert.deepEqual(f.calls,[]);
  await turn();broken=false;await turn();assert.deepEqual(f.calls,[]);
  assert.equal((await q.resume()).ok,true);await until(()=>q.status==='idle');assert.equal(f.calls.length,1);
});

test('failure to save a completed result prevents later files and reboot never repeats a now-ineligible source',async t=>{
  const f=await fixture(t);let broken=true;
  const q=f.queue({worker:{convertCompatible:async file=>{f.calls.push(file);f.eligible.delete(file);return {ok:true};},killActive:()=>false},
    saveState:async data=>{if(broken&&data.run.cursor===1)throw Error('checkpoint disk full');await saveJSONStrict(f.stateFile,data);}});
  await q.start({all:true});await until(()=>q.status==='interrupted');assert.deepEqual(f.calls,[f.files[0]]);
  assert.equal(f.read().run.cursor,0);const saved=f.read();broken=false;
  const restored=f.queue({loadState:()=>saved});assert.equal(restored.status,'interrupted');
  await restored.resume();await until(()=>restored.status==='idle');assert.deepEqual(f.calls,f.files);
  assert.equal(restored.snapshot().skipped,1);
});

test('full-drive files defer while another drive proceeds, then resume without failed counts',async t=>{
  const f=await fixture(t);let full=true,releaseWait,waits=0;const attempts=[];
  const q=f.queue({worker:{convertCompatible:async file=>{attempts.push(file);
    return full&&file!==f.files[2] ? {ok:false,deferred:true,code:'storage',reason:'drive A needs space',storage:{mount:'/drive-a',required:100,available:0}} : {ok:true};},killActive:()=>false},
    sleep:()=>{waits++;return new Promise(resolve=>releaseWait=resolve);}});
  await q.start({all:true});await until(()=>!!releaseWait);
  assert.deepEqual(attempts,f.files);assert.equal(q.snapshot().converted,1);assert.equal(q.snapshot().failed,0);
  assert.equal(q.snapshot().remaining,2);assert.equal(q.snapshot().deferredCount,2);assert.equal(waits,1);
  assert.match(q.snapshot().waitingReason,/drive A needs space/);
  full=false;releaseWait();await until(()=>q.status==='idle');assert.equal(q.snapshot().converted,3);
  assert.equal(q.snapshot().history.length,3);assert.equal(q.snapshot().failed,0);
});

test('one streamed source waits while other queued sources convert',async t=>{
  const f=await fixture(t,2);let streaming=true,releaseWait;const attempts=[];
  const q=f.queue({worker:{convertCompatible:async file=>{attempts.push(file);return file===f.files[0]&&streaming
    ? {ok:false,deferred:true,code:'playback',reason:'currently being streamed'} : {ok:true};},killActive:()=>false},
    sleep:()=>new Promise(resolve=>releaseWait=resolve)});
  await q.start({all:true});await until(()=>!!releaseWait);
  assert.equal(q.snapshot().converted,1);assert.equal(q.snapshot().deferred[0].code,'playback');
  assert.deepEqual(attempts,f.files);streaming=false;releaseWait();await until(()=>q.status==='idle');
  assert.equal(q.snapshot().converted,2);assert.equal(q.snapshot().failed,0);
});

test('unknown physical drives and damage stay review failures rather than automatic deferrals',async t=>{
  const f=await fixture(t,2);
  const q=f.queue({worker:{convertCompatible:async()=>({ok:false,deferred:true,code:'unknown',reason:'Needs review: cannot confirm physical drive'}),killActive:()=>false}});
  await q.start({all:true});await until(()=>q.status==='idle');
  assert.equal(q.snapshot().failed,2);assert.equal(q.snapshot().deferredCount,0);
});

test('malformed saved queues cannot invoke a worker or become resumable',async t=>{
  const f=await fixture(t),saved=await savedPaused(f);saved.run.queue.push(saved.run.queue[0]);
  const q=f.queue({loadState:()=>saved});assert.equal(q.status,'idle');assert.equal(q.snapshot().canResume,false);
  assert.match(q.snapshot().lastError,/could not be read/);assert.deepEqual(f.calls,[]);
});

test('source fingerprints reject symbolic links and identify replaced content',async t=>{
  const f=await fixture(t,1),before=await createQueue.fileFingerprint(f.files[0]);
  const link=path.join(f.dir,'alias.mkv');await fs.promises.symlink(f.files[0],link);
  assert.equal(await createQueue.fileFingerprint(link),null);
  await fs.promises.writeFile(f.files[0],'different content');
  assert.notDeepEqual(await createQueue.fileFingerprint(f.files[0]),before);
});

test('concurrent Start calls cannot create two workers while candidates are being prepared',async t=>{
  const f=await fixture(t,1);let release;
  const q=f.queue({getEligibleFiles:()=>new Promise(resolve=>release=resolve)});
  const first=q.start();await turn();assert.equal((await q.start()).ok,false);
  release(f.files);assert.equal((await first).ok,true);await until(()=>q.status==='idle');assert.equal(f.calls.length,1);
});

test('Stop during fingerprint preparation persists cancellation and never starts a worker',async t=>{
  const f=await fixture(t,1);let release;
  const q=f.queue({getFingerprint:()=>new Promise(resolve=>release=resolve)});
  const starting=q.start();await until(()=>!!release);assert.equal((await q.stop()).ok,true);
  release(await createQueue.fileFingerprint(f.files[0]));assert.equal((await starting).ok,false);
  assert.equal(f.queue().status,'idle');assert.deepEqual(f.calls,[]);
});

test('Stop during Resume validation cannot revive the run after validation finishes',async t=>{
  const f=await fixture(t,1),saved=await savedPaused(f);let release;
  const q=f.queue({loadState:()=>saved,getEligibleFiles:()=>new Promise(resolve=>release=resolve)});
  const resuming=q.resume();await until(()=>!!release);await q.stop();release(f.files);
  assert.equal((await resuming).ok,false);assert.equal(f.queue().status,'idle');assert.deepEqual(f.calls,[]);
});
