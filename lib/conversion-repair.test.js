const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {execFileSync}=require('child_process');
const {EventEmitter}=require('events');
const {PassThrough}=require('stream');
const createRepair=require('./conversion-repair');
const {validateRepairSource,verifyChapters,subtitleCues}=createRepair;
const createReview=require('./conversion-review');
const {fileFingerprint}=createReview;
const {saveJSONStrict}=require('./json-store');

async function fixture(t,options={}) {
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'conversion-repair-'));
  t.after(()=>fs.promises.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'Reviewed movie.mkv'),stateFile=path.join(dir,'repairs.json');
  await fs.promises.writeFile(file,'original fixture remains intact');
  const review=createReview({file:path.join(dir,'reviews.json'),save:saveJSONStrict});
  const config={enabled:true,schedule:{start:'',end:''},cpuCores:1,ffmpegThreads:1,niceness:19,minFreeSpaceGB:0};
  let busy=false,playing=false,allowed=true,drive={known:true,available:1e12};
  const settings={review,stateFile,save:saveJSONStrict,getConfig:()=>config,getLimits:()=>config,
    isConversionBusy:()=>busy,isPlaybackActive:()=>playing,isAllowedPath:()=>allowed,
    storage:{freeSpace:async()=>drive},monitorMs:20,...options};
  const register=async()=>{
    const fingerprint=await fileFingerprint(file),entry={filePath:file,fingerprint,mediaId:'abcdef0123456789'};
    const result=await review.record(entry,{ok:false,reason:'Needs review: source packet parser reported a bounded warning'});
    return review.get(result.id);
  };
  const entry=await register(),manager=createRepair(settings);
  return {dir,file,stateFile,review,config,entry,manager,register,settings,
    set busy(value){busy=value;},set playing(value){playing=value;},set allowed(value){allowed=value;},set drive(value){drive=value;}};
}
function blockedChild() {
  const children=[],signals=[];
  const spawnChild=(command,args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=100000000;
    child.kill=signal=>{signals.push(signal);if(signal==='SIGTERM'||signal==='SIGKILL')setImmediate(()=>child.emit('close',1));return true;};
    children.push({command,args,child});return child;
  };
  return {children,signals,spawnChild};
}
async function until(predicate) {
  for(let n=0;n<200;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw Error('Fixture condition did not arrive');
}
function generate(file,{duration=2.2,extras=false}={}) {
  const args=['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000'];
  if(extras) {
    const dir=path.dirname(file),sub=path.join(dir,'fixture.srt'),meta=path.join(dir,'fixture.ffmetadata');
    fs.writeFileSync(sub,'1\n00:00:00,200 --> 00:00:00,800\nFirst subtitle\n\n2\n00:00:01,200 --> 00:00:01,800\nSecond subtitle\n');
    fs.writeFileSync(meta,';FFMETADATA1\ntitle=Fixture movie\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2200\ntitle=Ending\n');
    args.push('-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-i',sub,'-i',meta,
      '-map','0:v:0','-map','1:a:0','-map','2:a:0','-map','3:s:0','-map_metadata','4','-map_chapters','4','-c:s','srt',
      '-metadata:s:a:0','language=spa','-metadata:s:a:0','title=Spanish main','-disposition:a:0','default',
      '-metadata:s:a:1','language=eng','-metadata:s:a:1','title=English main','-disposition:a:1','0',
      '-metadata:s:s:0','language=eng','-ac:a:1','2');
  }
  args.push('-t',String(duration),'-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','ac3','-ac:a:0','6','-y',file);
  execFileSync('ffmpeg',args,{stdio:'pipe',timeout:20000});
}
function probe(file){return JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_chapters','-show_format','-of','json',file],{encoding:'utf8',timeout:20000}));}

test('repair-only source warnings are recorded without disabling timestamp or duration validation',()=>{
  const input={streams:[{index:0,codec_type:'video',duration:'10'},{index:1,codec_type:'audio',duration:'10'}],format:{duration:'10'}};
  const stream=index=>({index,type:index?'audio':'video',packets:100,min:0,end:10,duration:10,backwards:0,missingTimestamps:0});
  const inventory={warningBytes:20,warnings:'Invalid EBML header warning',streams:[stream(0),stream(1)]};
  assert.equal(validateRepairSource(input,inventory),10);
  assert.throws(()=>validateRepairSource(input,{...inventory,warnings:'File ended prematurely'}),/incomplete/);
  assert.throws(()=>validateRepairSource(input,{...inventory,warningBytes:65537}),/too many media errors/);
  assert.throws(()=>validateRepairSource(input,{...inventory,streams:[{...stream(0),duration:5,end:5},stream(1)]}),/duration.*differs/);
  assert.throws(()=>validateRepairSource(input,{...inventory,streams:[{...stream(0),backwards:1},stream(1)]}),/timestamp\/packet/);
});

test('chapter and subtitle comparison rejects lost information',()=>{
  const source={chapters:[{start_time:'0',end_time:'1',tags:{title:'Opening'}}]};
  verifyChapters(source,source);assert.throws(()=>verifyChapters(source,{chapters:[]}),/not preserved/);
  assert.throws(()=>verifyChapters(source,{chapters:[{start_time:'0',end_time:'1',tags:{title:'Changed'}}]}),/not preserved/);
  assert.throws(()=>verifyChapters(source,{chapters:[{start_time:'N/A',end_time:'1',tags:{title:'Opening'}}]}),/not preserved/);
  assert.deepEqual(subtitleCues('1\n00:00:01,000 --> 00:00:02,000\nKept\n'),[{start:1,end:2,text:'Kept'}]);
  assert.throws(()=>subtitleCues('unverifiable subtitle'),/timing/);
  const chapterProbe={chapters:source.chapters,streams:[{index:5,codec_type:'data',codec_name:'bin_data'}]};
  assert.equal(createRepair.candidateWarnings('Unsupported codec with id 98314 for input stream 5',chapterProbe),'');
  assert.match(createRepair.candidateWarnings('Unsupported codec with id 98314 for input stream 0',chapterProbe),/Unsupported/);
  assert.match(createRepair.candidateWarnings('Decode corruption',{...chapterProbe}),/Decode corruption/);
});

test('only opaque current review IDs and current allowed regular source fingerprints can start',async t=>{
  const f=await fixture(t),original=await fs.promises.readFile(f.file);
  await assert.rejects(f.manager.start(f.file),error=>error.status===400);
  await assert.rejects(f.manager.start('a'.repeat(32)),error=>error.status===404);
  f.allowed=false;await assert.rejects(f.manager.start(f.entry.id),error=>error.status===409);f.allowed=true;
  await fs.promises.appendFile(f.file,'changed');
  await assert.rejects(f.manager.start(f.entry.id),error=>error.status===409);
  assert.equal(f.manager.busy,false);assert.equal(fs.existsSync(path.join(f.dir,'.conversion-repairs')),false);
  assert.notDeepEqual(await fs.promises.readFile(f.file),original,'only the explicit fixture edit changed the source');
});

test('symlinks in the source or a source ancestor cannot become repair input',async t=>{
  const f=await fixture(t);await fs.promises.rename(f.file,f.file+'.original');await fs.promises.symlink(f.file+'.original',f.file);
  await assert.rejects(f.manager.start(f.entry.id),error=>error.status===409);
  assert.equal(fs.existsSync(path.join(f.dir,'.conversion-repairs')),false);
});

test('queue, playback, disabled setting, schedule and storage guards reserve no output work',async t=>{
  const f=await fixture(t);
  f.busy=true;await assert.rejects(f.manager.start(f.entry.id),error=>error.status===409);f.busy=false;
  f.playing=true;await assert.rejects(f.manager.start(f.entry.id),error=>error.code==='EPLAYBACK');f.playing=false;
  f.config.enabled=false;await assert.rejects(f.manager.start(f.entry.id),/Enable conversion/);f.config.enabled=true;
  const minute=new Date().getHours()*60+new Date().getMinutes(),start=(minute+2)%1440,end=(minute+3)%1440;
  const time=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
  f.config.schedule={start:time(start),end:time(end)};await assert.rejects(f.manager.start(f.entry.id),/schedule/);f.config.schedule={start:'',end:''};
  f.drive={known:false};await assert.rejects(f.manager.start(f.entry.id),error=>error.code==='ESTORAGE');
  f.drive={known:true,available:0};await assert.rejects(f.manager.start(f.entry.id),error=>error.code==='ESTORAGE');
  assert.deepEqual(await fs.promises.readdir(f.dir),['Reviewed movie.mkv','reviews.json']);
});

test('one repair reservation rejects overlap; Stop resumes the child before terminating and preserves the original',async t=>{
  const runner=blockedChild(),f=await fixture(t,{spawnChild:runner.spawnChild}),original=await fs.promises.readFile(f.file);
  await f.manager.start(f.entry.id);await until(()=>runner.children.length===1);
  await assert.rejects(f.manager.start(f.entry.id),error=>error.status===409);
  assert.equal((await f.manager.snapshot()).busy,true);
  await f.manager.stop();await f.manager.wait();
  assert.deepEqual(runner.signals.slice(0,2),['SIGCONT','SIGTERM']);
  assert.equal((await f.manager.snapshot()).status,'cancelled');assert.equal(f.manager.busy,false);
  assert.deepEqual(await fs.promises.readFile(f.file),original);assert.equal((await f.review.snapshot()).total,1);
  assert.equal((await f.manager.snapshot()).candidate,null);
});

test('playback starting during repair stops the child and keeps review and original',async t=>{
  const runner=blockedChild(),f=await fixture(t,{spawnChild:runner.spawnChild});
  await f.manager.start(f.entry.id);await until(()=>runner.children.length===1);f.playing=true;
  await f.manager.wait();
  assert.match((await f.manager.snapshot()).error,/Playback/);assert.equal((await f.review.snapshot()).total,1);
  assert.deepEqual(runner.signals.slice(0,2),['SIGCONT','SIGTERM']);
});

test('a child processing deadline cannot publish an unverified candidate',async t=>{
  const runner=blockedChild(),f=await fixture(t,{spawnChild:runner.spawnChild,commandTimeoutMs:50});
  await f.manager.start(f.entry.id);await f.manager.wait();
  assert.match((await f.manager.snapshot()).error,/deadline/);assert.equal((await f.manager.snapshot()).candidate,null);
});

test('the overall repair deadline also bounds the whole sequence of processing steps',async t=>{
  const runner=blockedChild(),f=await fixture(t,{spawnChild:runner.spawnChild,maxJobMs:50,commandTimeoutMs:5000});
  await f.manager.start(f.entry.id);await f.manager.wait();
  assert.match((await f.manager.snapshot()).error,/deadline/);assert.equal((await f.manager.snapshot()).candidate,null);
});

test('Stop during asynchronous startup checks cannot authorize or spawn a repair afterwards',async t=>{
  let release,entered;const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const runner=blockedChild(),f=await fixture(t,{spawnChild:runner.spawnChild,storage:{freeSpace:async()=>{entered();await waiting;return{known:true,available:1e12};}}});
  const job=f.manager.start(f.entry.id);await started;await f.manager.stop();release();
  await assert.rejects(job,error=>error.code==='ECANCELLED');assert.equal(runner.children.length,0);assert.equal(f.manager.busy,false);
  assert.equal((await f.review.snapshot()).total,1);
});

test('failed durable reservation cannot spawn work or expose a candidate',async t=>{
  const runner=blockedChild(),f=await fixture(t,{spawnChild:runner.spawnChild,save:async()=>{throw Error('private state write failed');}});
  await assert.rejects(f.manager.start(f.entry.id),error=>error.status===503);
  assert.equal(runner.children.length,0);assert.equal(f.manager.busy,false);
  assert.equal(fs.existsSync(path.join(f.dir,'.conversion-repairs')),false);
});

test('startup recovery runs before state loading and interrupted work never resumes automatically',async t=>{
  const runner=blockedChild(),f=await fixture(t,{spawnChild:runner.spawnChild});
  await f.manager.start(f.entry.id);await until(()=>runner.children.length===1);
  const saved=JSON.parse(await fs.promises.readFile(f.stateFile));await f.manager.stop();await f.manager.wait();
  await saveJSONStrict(f.stateFile,saved);
  let recovered=false;
  const fresh=createRepair({...f.settings,beforeReady:async()=>{recovered=true;}});
  await fresh.ready();assert.equal(recovered,true);assert.equal((await fresh.snapshot()).status,'interrupted');
  assert.equal(fresh.busy,false);assert.equal(runner.children.length,1);
  assert.equal(JSON.stringify(await fresh.snapshot()).includes(f.dir),false);
});

test('corrupt or symlink private state fails closed',async t=>{
  const f=await fixture(t);await fs.promises.writeFile(f.stateFile,'null');
  await assert.rejects(f.manager.ready(),error=>error.code==='EREPAIRSTATE');
  await fs.promises.unlink(f.stateFile);await fs.promises.symlink(f.file,f.stateFile);
  await assert.rejects(createRepair(f.settings).ready(),error=>error.code==='EREPAIRSTATE');
});

async function readyFixture(t,options={}) {
  const f=await fixture(t,options),candidatePath=path.join(f.dir,'.conversion-repairs',f.entry.id,'candidate.mp4');
  await fs.promises.mkdir(path.dirname(candidatePath),{recursive:true,mode:0o700});
  await fs.promises.writeFile(candidatePath,'synthetic verified-state interface fixture');
  const record={reviewId:f.entry.id,entry:f.entry,candidatePath,candidateFingerprint:await fileFingerprint(candidatePath),
    outputProbe:{streams:[{index:0,codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p'},{index:1,codec_type:'audio',codec_name:'aac',channels:2}],chapters:[]},
    status:'ready',stage:'Verified repair copy ready',progress:{percent:100,seconds:0,duration:2,speed:''},warnings:[],error:'',updatedAt:Date.now()};
  await saveJSONStrict(f.stateFile,{version:1,records:[record]});
  return Object.assign(f,{candidatePath,record});
}

test('verified adoption reserves the operation and commits only after review removal and installed state durability',async t=>{
  const f=await readyFixture(t);let committed=false;
  const result=await f.manager.apply(f.entry.id,async descriptor=>{
    assert.equal(f.manager.busy,true);assert.equal(descriptor.filePath,f.candidatePath);assert.equal(descriptor.entry.mediaId,f.entry.mediaId);
    await assert.rejects(f.manager.start(f.entry.id),error=>error.status===409);
    await assert.rejects(f.manager.stop(),error=>error.status===409);
    return {ok:true,verified:true,rollback:async()=>assert.fail('successful install must not roll back'),commit:async()=>{
      assert.equal((await f.review.snapshot()).total,0);
      assert.equal(JSON.parse(await fs.promises.readFile(f.stateFile)).records[0].status,'installed');committed=true;
    }};
  });
  assert.equal(result.status,'installed');assert.equal(committed,true);assert.equal(f.manager.busy,false);
});

test('installer refusal preserves a ready copy and never completes the source review',async t=>{
  const f=await readyFixture(t),original=await fs.promises.readFile(f.file);
  await assert.rejects(f.manager.apply(f.entry.id,async()=>{throw Error('installation preflight refused');}),/preflight refused/);
  assert.equal((await f.manager.snapshot()).status,'ready');assert.equal((await f.review.snapshot()).total,1);
  assert.equal((await f.manager.candidate(f.entry.id)).filePath,f.candidatePath);
  assert.deepEqual(await fs.promises.readFile(f.file),original);
});

test('post-install state failure invokes rollback and restores a hold using the restored source fingerprint',async t=>{
  let rejectOnce=true;
  const f=await readyFixture(t,{save:async(file,data)=>{
    if(data.records[0].status==='installed'&&rejectOnce){rejectOnce=false;throw Error('installed checkpoint failed');}
    return saveJSONStrict(file,data);
  }}),original=await fs.promises.readFile(f.file),backup=f.file+'.preserved',output=f.file+'.replacement';
  let rolledBack=false,committed=false;
  await assert.rejects(f.manager.apply(f.entry.id,async descriptor=>{
    await fs.promises.rename(descriptor.entry.filePath,backup);await fs.promises.rename(descriptor.filePath,output);
    return {ok:true,verified:true,rollback:async()=>{
      await fs.promises.rename(backup,f.file);await fs.promises.rename(output,f.candidatePath);rolledBack=true;
    },commit:async()=>{committed=true;}};
  }),/checkpoint failed/);
  assert.equal(rolledBack,true);assert.equal(committed,false);assert.deepEqual(await fs.promises.readFile(f.file),original);
  assert.equal((await f.manager.snapshot()).status,'failed');assert.equal((await f.review.snapshot()).total,1);
  const restored=(await f.review.snapshot()).entries[0];assert.deepEqual(restored.fingerprint,await fileFingerprint(f.file));
  assert.equal(fs.existsSync(f.candidatePath),true);
});

test('commit failure reports recovery requirement and never rolls back the saved replacement',async t=>{
  const f=await readyFixture(t);let rollback=false;
  const result=await f.manager.apply(f.entry.id,async()=>({ok:true,verified:true,
    rollback:async()=>{rollback=true;},commit:async()=>{throw Error('journal phase unavailable');}}));
  assert.equal(rollback,false);assert.equal(result.status,'installed');assert.match(result.cleanupWarning,/installation record needs recovery/);
  assert.match((await f.manager.snapshot()).warnings[0],/original retained/);
});

test('startup journal rollback overrides a previously persisted installed label',async t=>{
  const f=await readyFixture(t);f.record.status='installed';await saveJSONStrict(f.stateFile,{version:1,records:[f.record]});
  const fresh=createRepair({...f.settings,beforeReady:async()=>({rolledBack:[f.entry.id]})});
  assert.equal((await fresh.snapshot()).status,'interrupted');assert.equal(fresh.busy,false);
});

test('preview and adoption both reject modified, linked or no-longer-authorized candidates before installer calls',async t=>{
  const f=await readyFixture(t);let calls=0;
  f.playing=true;await assert.rejects(f.manager.apply(f.entry.id,async()=>{calls++;}),/Playback/);f.playing=false;
  f.busy=true;await assert.rejects(f.manager.apply(f.entry.id,async()=>{calls++;}),/normal conversion/);f.busy=false;
  f.allowed=false;await assert.rejects(f.manager.candidate(f.entry.id),error=>error.status===409);f.allowed=true;
  await fs.promises.unlink(f.candidatePath);await fs.promises.symlink(f.file,f.candidatePath);
  await assert.rejects(f.manager.candidate(f.entry.id),error=>error.status===409);
  await assert.rejects(f.manager.apply(f.entry.id,async()=>{calls++;}),error=>error.status===503);
  assert.equal(calls,0);assert.equal((await f.review.snapshot()).total,1);
});

test('nonregular FIFO private state is rejected without waiting for another process', {timeout:1000},async t=>{
  const f=await fixture(t);execFileSync('mkfifo',[f.stateFile]);
  await assert.rejects(f.manager.ready(),error=>error.code==='EREPAIRSTATE');
});

test('real FFmpeg repair preserves originals, all audio tracks, subtitles and chapters; preview is durable and tamper-checked', {timeout:90000}, async t=>{
  const f=await fixture(t);generate(f.file,{extras:true});const entry=await f.register(),original=await fs.promises.readFile(f.file);
  await f.manager.start(entry.id);await f.manager.wait();const status=await f.manager.snapshot();
  assert.equal(status.status,'ready',status.error);assert.equal(status.progress.percent,100);assert.equal(status.candidate.verified,true);
  assert.deepEqual(await fs.promises.readFile(f.file),original);assert.equal((await f.review.snapshot()).total,1);
  const descriptor=await f.manager.candidate(entry.id),output=probe(descriptor.filePath);
  assert.equal(output.streams.find(s=>s.codec_type==='video').codec_name,'h264');
  assert.equal(output.streams.filter(s=>s.codec_type==='audio').length,3);
  const audio=output.streams.filter(s=>s.codec_type==='audio');
  assert.deepEqual(audio.map(s=>s.tags.language),['eng','spa','eng']);
  assert.deepEqual(audio.map(s=>s.disposition.default),[1,0,0]);
  assert.deepEqual(audio.map(s=>s.tags.handler_name),['English main (Browser stereo)','Spanish main','English main']);
  assert.equal(output.streams.filter(s=>s.codec_type==='subtitle').length,1);
  assert.deepEqual(output.chapters.map(c=>c.tags.title),['Opening','Ending']);
  assert.equal(path.relative(f.dir,descriptor.filePath),path.join('.conversion-repairs',entry.id,'candidate.mp4'));
  assert.equal(JSON.stringify(status).includes(f.dir),false);
  const fresh=createRepair(f.settings);assert.equal((await fresh.candidate(entry.id)).filePath,descriptor.filePath);
  f.allowed=false;await assert.rejects(f.manager.candidate(entry.id),error=>error.status===409);f.allowed=true;
  await fs.promises.appendFile(descriptor.filePath,'tampered');
  await assert.rejects(fresh.candidate(entry.id),error=>error.status===409);
  assert.deepEqual(await fs.promises.readFile(f.file),original);
});

test('a materially truncated real source can never publish a shorter repair copy', {timeout:90000}, async t=>{
  const f=await fixture(t);generate(f.file,{duration:3});const bytes=await fs.promises.readFile(f.file);
  await fs.promises.writeFile(f.file,bytes.subarray(0,Math.floor(bytes.length*0.55)));
  const entry=await f.register(),original=await fs.promises.readFile(f.file);
  await f.manager.start(entry.id);await f.manager.wait();const status=await f.manager.snapshot();
  assert.equal(status.status,'failed');assert.match(status.error,/incomplete|duration|media errors/);
  assert.equal(status.candidate,null);assert.deepEqual(await fs.promises.readFile(f.file),original);
  assert.equal((await f.review.snapshot()).total,1);
});

test('a real verified candidate is withdrawn if its ready checkpoint cannot be durably saved', {timeout:90000},async t=>{
  let rejectOnce=true;
  const f=await fixture(t,{save:async(file,data)=>{
    if(data.records[0].status==='ready'&&rejectOnce){rejectOnce=false;throw Error('ready checkpoint failed');}
    return saveJSONStrict(file,data);
  }});generate(f.file);const entry=await f.register(),original=await fs.promises.readFile(f.file);
  await f.manager.start(entry.id);await f.manager.wait();const result=await f.manager.snapshot();
  assert.equal(result.status,'failed');assert.match(result.error,/checkpoint/);assert.equal(result.candidate,null);
  assert.equal(fs.existsSync(path.join(f.dir,'.conversion-repairs',entry.id,'candidate.mp4')),false);
  assert.deepEqual(await fs.promises.readFile(f.file),original);assert.equal((await f.review.snapshot()).total,1);
});
