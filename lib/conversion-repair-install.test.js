const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const create=require('./conversion-repair-install');
const {createMediaIdentity}=require('./media-identity');
const fp=async file=>{const st=await fs.lstat(file);return Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs'].map(k=>[k,st[k]]));};
async function fixture(t,ext='avi',seedId=null) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'repair-install-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'movie.'+ext), id='a'.repeat(32), candidate=path.join(root,'.conversion-repairs',id,'candidate.mp4');
  await fs.mkdir(path.dirname(candidate),{recursive:true});await fs.writeFile(source,'original source');await fs.writeFile(candidate,'verified candidate');
  const save=async(file,data)=>{await fs.writeFile(file+'.tmp',JSON.stringify(data));await fs.rename(file+'.tmp',file);};
  const identity=createMediaIdentity({file:path.join(root,'identities.json'),save});
  if(seedId)identity.seed([{id:seedId,_filePath:source}]);
  await identity.resolve(source,await fs.stat(source));await identity.persist();const mediaId=identity.idForPath(source);
  const entry={id,filePath:source,fingerprint:await fp(source),mediaId};const records=[];
  const options={file:path.join(root,'journal.json'),save,identity,review:{record:async(e,r)=>records.push({entry:e,result:r})},isAllowedPath:async f=>path.dirname(f)===root};
  return {root,source,candidate,entry,mediaId,options,identity,records,manager:create(options),descriptor:{entry,filePath:candidate,candidateFingerprint:await fp(candidate)}};
}
test('selected repair retains original even when replacing an MP4 and preserves its media ID',async t=>{
  const f=await fixture(t,'mp4');const installed=await f.manager.install(f.descriptor);
  assert.equal(await fs.readFile(f.source,'utf8'),'verified candidate');assert.equal(await fs.readFile(installed.retainedPath,'utf8'),'original source');
  assert.equal(f.identity.idForPath(f.source),f.mediaId);assert.equal(installed.originalDeleted,false);
  await installed.commit();assert.equal(f.manager.busy,false);await assert.rejects(fs.stat(f.options.file),{code:'ENOENT'});
});
test('verified AVI replacement keeps progress identity and can roll back a later durability failure',async t=>{
  const f=await fixture(t);const installed=await f.manager.install(f.descriptor);
  assert.equal(f.identity.idForPath(installed.newPath),f.mediaId);await installed.rollback();
  assert.equal(await fs.readFile(f.source,'utf8'),'original source');assert.equal(await fs.readFile(f.candidate,'utf8'),'verified candidate');
  assert.equal(f.identity.idForPath(f.source),f.mediaId);assert.equal(f.records.length,1);assert.equal(f.manager.busy,false);
});
test('process interruption after publishing output restores source, candidate and stable ID on restart',async t=>{
  const f=await fixture(t);const installed=await f.manager.install(f.descriptor);
  const restartedIdentity=createMediaIdentity({file:path.join(f.root,'identities.json'),save:f.options.save});
  await create({...f.options,identity:restartedIdentity}).recover();
  assert.equal(await fs.readFile(f.source,'utf8'),'original source');assert.equal(await fs.readFile(f.candidate,'utf8'),'verified candidate');
  assert.equal(restartedIdentity.idForPath(f.source),f.mediaId);await assert.rejects(fs.stat(installed.newPath),{code:'ENOENT'});
});
test('identity persistence failure restores both media files',async t=>{
  const f=await fixture(t);let fail=true;
  const identity={...f.identity,relocate:async(...args)=>{if(fail){fail=false;throw Error('identity disk full');}return f.identity.relocate(...args);}};
  await assert.rejects(create({...f.options,identity}).install(f.descriptor),/identity disk full/);
  assert.equal(await fs.readFile(f.source,'utf8'),'original source');assert.equal(await fs.readFile(f.candidate,'utf8'),'verified candidate');
});
test('restart recovery preserves an authoritative custom ID even when an older review has no media ID',async t=>{
  const f=await fixture(t,'avi','0123456789abcdef');f.entry.mediaId=null;
  await f.manager.install(f.descriptor);
  const identity=createMediaIdentity({file:path.join(f.root,'identities.json'),save:f.options.save});
  await create({...f.options,identity}).recover();
  assert.equal(identity.idForPath(f.source),'0123456789abcdef');
  assert.equal(await fs.readFile(f.source,'utf8'),'original source');
});
test('changed source, changed candidate, playback and destination collision never replace anything',async t=>{
  for(const change of ['source','candidate','playback','collision'])await t.test(change,async t=>{
    const f=await fixture(t);
    if(change==='source')await fs.appendFile(f.source,' changed');
    if(change==='candidate')await fs.appendFile(f.candidate,' changed');
    if(change==='collision')await fs.writeFile(path.join(f.root,'movie.mp4'),'unrelated file');
    const manager=create({...f.options,isPlaybackActive:()=>change==='playback'});
    await assert.rejects(manager.install(f.descriptor));
    assert.match(await fs.readFile(f.source,'utf8'),/^original source/);
    if(change==='collision')assert.equal(await fs.readFile(path.join(f.root,'movie.mp4'),'utf8'),'unrelated file');
  });
});
test('symlinked retained folder and candidate path escape are refused',async t=>{
  const f=await fixture(t);const outside=await fs.mkdtemp(path.join(os.tmpdir(),'repair-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.symlink(outside,path.join(f.root,'.converted-originals'));
  await assert.rejects(f.manager.install(f.descriptor),/symbolic links/);
  assert.equal(await fs.readFile(f.source,'utf8'),'original source');
  await fs.unlink(path.join(f.root,'.converted-originals'));
  await assert.rejects(f.manager.install({...f.descriptor,filePath:path.join(outside,'candidate.mp4')}),/paths/);
});
test('corrupt recovery journal blocks new installation',async t=>{
  const f=await fixture(t);await fs.writeFile(f.options.file,'{');await assert.rejects(f.manager.recover());
  await assert.rejects(f.manager.install(f.descriptor),/recovery needs attention/);
  assert.equal(await fs.readFile(f.source,'utf8'),'original source');
});
test('concurrent installation refuses second request and committed journal is not rolled back',async t=>{
  const f=await fixture(t);const installed=await f.manager.install(f.descriptor);
  await assert.rejects(f.manager.install(f.descriptor),/already running/);
  const original=JSON.parse(await fs.readFile(f.options.file,'utf8'));await f.options.save(f.options.file,{...original,phase:'committed'});
  await create(f.options).recover();assert.equal(await fs.readFile(installed.newPath,'utf8'),'verified candidate');
  assert.equal(await fs.readFile(installed.retainedPath,'utf8'),'original source');
});

test('real media repair integrates verification, explicit installation, review retirement and restart', {timeout:30000},async t=>{
  const {execFileSync}=require('node:child_process');
  const createReview=require('./conversion-review'),createRepair=require('./conversion-repair'),{saveJSONStrict:save}=require('./json-store');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'repair-complete-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'movie.mkv');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','ac3','-ac','2',source],{stdio:'pipe'});
  const original=await fs.readFile(source),identity=createMediaIdentity({file:path.join(root,'identity.json'),save});
  identity.seed([{id:'0123456789abcdef',_filePath:source}]);await identity.resolve(source,await fs.stat(source));await identity.persist();
  const review=createReview({file:path.join(root,'review.json'),save});
  const result=await review.record({filePath:source,fingerprint:await fp(source),mediaId:identity.idForPath(source)},{ok:false,reason:'Source needs review'});
  const installer=create({file:path.join(root,'install.json'),save,review,identity,isAllowedPath:async name=>path.dirname(name)===root});
  const options={review,stateFile:path.join(root,'repairs.json'),save,isAllowedPath:async name=>path.dirname(name)===root,
    getConfig:()=>({enabled:true,cpuCores:1,ffmpegThreads:1,minFreeSpaceGB:0,schedule:{start:'',end:''},retainOriginals:false}),
    storage:{freeSpace:async()=>({known:true,available:1e12})},beforeReady:installer.recover};
  const manager=createRepair(options);await manager.start(result.id);await manager.wait();
  const snapshot=await manager.snapshot();assert.equal(snapshot.status,'ready',snapshot.error);
  assert.deepEqual(await fs.readFile(source),original);assert.equal((await review.snapshot()).total,1);
  assert.equal((await manager.apply(result.id,installer.install)).ok,true);
  assert.equal((await manager.snapshot()).status,'installed');assert.equal((await review.snapshot()).total,0);
  assert.deepEqual(await fs.readFile(path.join(root,'.converted-originals','movie.mkv')),original);
  assert.equal(identity.idForPath(path.join(root,'movie.mp4')),'0123456789abcdef');
  assert.equal((await createRepair(options).snapshot()).status,'installed');
});
