const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const os=require('os');const path=require('path');const {execFileSync}=require('child_process');const crypto=require('crypto');
const createWorker=require('./conversion-worker');
function fixture(t,limits={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'conversion-pipeline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const caches=Object.fromEntries(['probeCache','pixFmtCache','audioProbeCache','audioTracksCache','subProbeCache','heightCache','levelCache'].map(key=>[key,{}]));
 const hashId=f=>crypto.createHash('sha1').update(f).digest('hex');let profile={progress:{},history:[],queue:[],watchlist:[]};
 const worker=createWorker({...caches,hashId,markDirty(){},scheduleSaveMediaInfo(){},getActiveTranscodeFilePaths:()=>new Set(),loadProfileData:()=>profile,saveProfileData:(_,value)=>profile=value,profileIds:()=>['test'],TEXT_SUB_CODECS:new Set(['subrip']),getLimits:()=>({cpuCores:1,niceness:19,minFreeSpaceGB:0,...limits})});
 return {dir,worker,caches,hashId,get profile(){return profile;}};
}
function generate(file,codec='libx264',seconds=2){
 const extra=codec==='libx265'?['-x265-params','pools=1:frame-threads=1:log-level=error']:[];
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(seconds),'-c:v',codec,'-threads','1',...extra,'-pix_fmt','yuv420p','-c:a','ac3','-ac','6',file],{stdio:'pipe'});
}
function probe(file){return JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8'}));}
test('actual same-path MP4 conversion is verified, retained with fresh age, and restorable',async t=>{
 const f=fixture(t),file=path.join(f.dir,'sample.mp4');generate(file);
 const original=fs.readFileSync(file);fs.utimesSync(file,new Date('2000-01-01'),new Date('2000-01-01'));
 const result=await f.worker.convertCompatible(file);assert.equal(result.ok,true,result.reason);
 const output=probe(file);const audio=output.streams.filter(s=>s.codec_type==='audio');
 assert.equal(audio[0].codec_name,'aac');assert.equal(audio[0].channels,2);assert.equal(audio[1].codec_name,'ac3');
 const originals=await f.worker.listRetainedOriginals([f.dir],14);assert.equal(originals.length,1);assert.equal(originals[0].expired,false);
 assert.deepEqual(fs.readFileSync(result.retainedPath),original);
 assert.equal(f.worker.restoreOriginal(result.retainedPath).ok,true);assert.deepEqual(fs.readFileSync(file),original);
 assert.equal(f.caches.probeCache[file],undefined,'restore must invalidate the H264/AAC replacement metadata');
});
test('actual HEVC SDR conversion becomes H264 and migrates watch progress',async t=>{
 const f=fixture(t),file=path.join(f.dir,'sample.mkv');generate(file,'libx265');
 const old=f.hashId(file);f.profile.progress[old]={currentTime:1};
 const result=await f.worker.convertCompatible(file);assert.equal(result.ok,true,result.reason);
 assert.equal(probe(result.newPath).streams.find(s=>s.codec_type==='video').codec_name,'h264');
 assert.equal(f.profile.progress[result.newId].currentTime,1);assert.equal(f.profile.progress[old],undefined);
});

for (const extension of ['mp4','mkv']) test(`delete-original mode keeps a verified ${extension} replacement and watch progress without a backup`,async t=>{
 const f=fixture(t,{retainOriginals:false}),file=path.join(f.dir,'sample.'+extension);generate(file);
 const old=f.hashId(file);f.profile.progress[old]={currentTime:1};
 const result=await f.worker.convertCompatible(file);assert.equal(result.ok,true,result.reason);
 assert.equal(result.originalDeleted,true);assert.equal(result.retainedPath,null);
 assert.equal(fs.existsSync(result.newPath),true);
 const output=probe(result.newPath);assert.equal(output.streams.find(s=>s.codec_type==='audio').codec_name,'aac');
 assert.equal(f.profile.progress[result.newId].currentTime,1);
 assert.equal((await f.worker.listRetainedOriginals([f.dir],14)).length,0);
 assert.equal(fs.existsSync(path.join(f.dir,'.converted-originals')),false);
});

test('delete-original mode still preserves a source when conversion fails or stops',async t=>{
 const f=fixture(t,{retainOriginals:false}),file=path.join(f.dir,'sample.mkv');generate(file);
 const original=fs.readFileSync(file);fs.writeFileSync(path.join(f.dir,'sample.mp4'),'existing destination');
 const failed=await f.worker.convertCompatible(file);assert.equal(failed.ok,false);assert.deepEqual(fs.readFileSync(file),original);
 fs.unlinkSync(path.join(f.dir,'sample.mp4'));f.worker.setPaused(true);
 const job=f.worker.convertCompatible(file);await new Promise(resolve=>setTimeout(resolve,150));f.worker.killActive();
 assert.equal((await job).ok,false);assert.deepEqual(fs.readFileSync(file),original);
});

test('post-verification deletion failure preserves the backup and cannot throw into rollback',()=>{
 const {finalizeOriginal}=createWorker;
 const failed=finalizeOriginal('/backup/source.mkv',false,{unlinkSync(){throw Error('read-only filesystem');}});
 assert.equal(failed.originalDeleted,false);assert.equal(failed.retainedPath,'/backup/source.mkv');assert.match(failed.cleanupWarning,/read-only/);
 let calls=0;
 const deleted=finalizeOriginal('/backup/source.mkv',false,{unlinkSync(){if(++calls>1)throw Error('marker cleanup failed');},readdirSync(){throw Error('directory unavailable');}});
 assert.equal(deleted.originalDeleted,true);assert.equal(deleted.retainedPath,null);
});
test('stop during a suspended job preserves the source and discards its temporary output',async t=>{
 const f=fixture(t),file=path.join(f.dir,'sample.mp4');generate(file);
 const original=fs.readFileSync(file);f.worker.setPaused(true);
 const job=f.worker.convertCompatible(file);
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.deepEqual(fs.readFileSync(file),original);f.worker.killActive();
 const result=await job;assert.equal(result.ok,false);assert.deepEqual(fs.readFileSync(file),original);
 assert.equal((await f.worker.listRetainedOriginals([f.dir],14)).length,0);
});
test('pause and resume complete the same real job without restarting it',async t=>{
 const f=fixture(t),file=path.join(f.dir,'sample.mp4');generate(file);
 f.worker.setPaused(true);let complete=false;const job=f.worker.convertCompatible(file).then(r=>{complete=true;return r;});
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(complete,false);
 f.worker.setPaused(false);const result=await job;assert.equal(result.ok,true,result.reason);
});
function retainedFixture(f,name,replacement=true){
 const dir=path.join(f.dir,'.converted-originals');fs.mkdirSync(dir,{recursive:true});
 const retained=path.join(dir,name+'.mkv');fs.writeFileSync(retained,'original');
 fs.writeFileSync(retained+'.conversion.json',JSON.stringify({retainedAt:Date.now()}));
 if(replacement)fs.writeFileSync(path.join(f.dir,name+'.mp4'),'converted');
 return retained;
}
test('manual cleanup previews recent originals and deletes only the selected original',async t=>{
 const f=fixture(t),a=retainedFixture(f,'one'),b=retainedFixture(f,'two');
 assert.equal((await f.worker.cleanupExpiredOriginals([f.dir],14,{dryRun:true})).candidates,0);
 const preview=await f.worker.cleanupExpiredOriginals([f.dir],14,{dryRun:true,includeRecent:true,retainedPaths:[a]});
 assert.equal(preview.candidates,1);assert.equal(fs.existsSync(a),true);
 const result=await f.worker.cleanupExpiredOriginals([f.dir],14,{includeRecent:true,retainedPaths:preview.retainedPaths});
 assert.equal(result.deleted.length,1);assert.equal(fs.existsSync(a),false);assert.equal(fs.existsSync(a+'.conversion.json'),false);
 assert.equal(fs.existsSync(b),true);assert.equal(fs.existsSync(path.join(f.dir,'one.mp4')),true);
});
test('delete all protects missing replacements and files added after the preview',async t=>{
 const f=fixture(t),a=retainedFixture(f,'one'),only=retainedFixture(f,'only',false);
 const preview=await f.worker.cleanupExpiredOriginals([f.dir],14,{dryRun:true,includeRecent:true});
 assert.equal(preview.candidates,1);assert.equal(preview.skippedOnlyCopy.length,1);
 const later=retainedFixture(f,'later');fs.unlinkSync(path.join(f.dir,'one.mp4'));
 const result=await f.worker.cleanupExpiredOriginals([f.dir],14,{includeRecent:true,retainedPaths:preview.retainedPaths});
 assert.equal(result.deleted.length,0);for(const p of [a,only,later])assert.equal(fs.existsSync(p),true);
});
test('manual deletion cannot select paths outside the enumerated library originals',async t=>{
 const f=fixture(t),a=retainedFixture(f,'one');
 const result=await f.worker.cleanupExpiredOriginals([f.dir],14,{includeRecent:true,retainedPaths:[path.join(f.dir,'one.mp4'),'/tmp/unrelated']});
 assert.equal(result.deleted.length,0);assert.equal(fs.existsSync(a),true);
});
test('cleanup rechecks conversion state after asynchronous discovery and preserves originals',async t=>{
 const f=fixture(t),a=retainedFixture(f,'one');
 await assert.rejects(f.worker.cleanupExpiredOriginals([f.dir],14,{includeRecent:true,retainedPaths:[a],canDelete:()=>false}),/Stop conversion/);
 assert.equal(fs.existsSync(a),true);
});
