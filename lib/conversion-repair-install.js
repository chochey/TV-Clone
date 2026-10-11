// Only installs an already verified repair selected by an administrator.
// The original is always retained. A durable journal rolls back an interrupted
// installation before another conversion/repair can start.
const fs = require('fs');
const path = require('path');
const {retainedPathFor,newPathFor} = require('./conversion-worker');
const fields = st => Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs'].map(k => [k,st[k]]));
const same = (a,b,renamed=false) => !!a && !!b && ['dev','ino','size','mtimeMs',...(renamed?[]:['ctimeMs'])].every(k => a[k]===b[k]);

module.exports = function createRepairInstaller({file,save,review,identity,isAllowedPath,isPlaybackActive=()=>false,onChanged=()=>{},io=fs.promises}) {
  let active=false, recoveryError=null;
  async function stat(name) {
    try {const st=await io.lstat(name);if(!st.isFile() || st.isSymbolicLink())throw Error('Repair files must be regular files');return fields(st);}
    catch(e) {if(e.code==='ENOENT')return null;throw e;}
  }
  async function sync(name) {const h=await io.open(name,'r');try{await h.sync();}finally{await h.close();}}
  async function paths(j) {
    if(j?.version!==1 || !/^[a-f0-9]{32}$/.test(j.id) || !j.entry?.filePath || !['prepared','committed'].includes(j.phase))throw Error('Invalid repair installation journal');
    const source=j.entry.filePath;
    if(j.retained!==retainedPathFor(source) || j.output!==newPathFor(source)
      || j.candidate!==path.join(path.dirname(source),'.conversion-repairs',j.id,'candidate.mp4'))throw Error('Invalid repair installation paths');
    if(!await isAllowedPath(source,{recovery:true}))throw Error('Repair source is outside a connected library');
    for(const dir of [path.dirname(source),path.dirname(j.retained),path.dirname(j.candidate)]) {
      if(await io.realpath(dir)!==path.resolve(dir))throw Error('Repair folders cannot be symbolic links');
    }
  }
  async function removeJournal() {await io.unlink(file);await sync(path.dirname(file));}
  // Hard links give us no-overwrite publication. Both links may exist after a
  // power loss, which recovery recognizes by inode instead of deleting blindly.
  async function move(from,to,fp) {
    if(!same(await stat(from),fp,true))throw Error('Repair file changed before installation');
    await io.link(from,to);
    await sync(path.dirname(to));
    if(!same(await stat(from),fp,true))throw Error('Repair file changed during installation');
    await io.unlink(from);await sync(path.dirname(from));
  }
  async function rollback(j,undo) {
    await paths(j);
    let out=await stat(j.output), candidate=await stat(j.candidate), source=await stat(j.entry.filePath), retained=await stat(j.retained);
    if(out && same(out,j.candidateFingerprint,true)) {
      if(candidate && !same(candidate,out,true))throw Error('Repair recovery found a different candidate; both copies kept');
      if(!candidate)await io.link(j.output,j.candidate);
      await sync(path.dirname(j.candidate));
      await io.unlink(j.output);await sync(path.dirname(j.output));
      if(j.output===j.entry.filePath)source=null;
    } else if(out && j.output!==j.entry.filePath)throw Error('Repair recovery found a changed destination; original retained');
    if(retained) {
      if(!same(retained,j.entry.fingerprint,true))throw Error('Retained original changed; automatic recovery stopped');
      if(source && !same(source,retained,true))throw Error('Original pathname contains another file; both copies kept');
      if(!source)await io.link(j.retained,j.entry.filePath);
      await sync(path.dirname(j.entry.filePath));
      if(undo)await undo();
      else if(j.output!==j.entry.filePath && identity.isCurrent(j.output,j.entry.mediaId))await identity.relocate(j.output,j.entry.filePath);
      else await identity.relocate(j.entry.filePath,j.entry.filePath);
      await io.unlink(j.retained);await sync(path.dirname(j.retained));
    } else if(!same(source,j.entry.fingerprint,true))throw Error('Cannot locate the original for repair recovery');
    try{await io.unlink(j.retained+'.conversion.json');}catch(e){if(e.code!=='ENOENT')throw e;}
    await review.record({...j.entry,fingerprint:await stat(j.entry.filePath)}, {ok:false,reason:'Repair installation interrupted; original restored'});
    await onChanged(j.entry.filePath,j.output);
    await removeJournal();
  }
  async function recover() {
    if(active)throw Error('Repair installation is busy');
    active=true;
    try {
      let j;try{j=JSON.parse(await io.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
      await paths(j);
      if(j.phase==='committed') {await removeJournal();return;}
      await rollback(j);return {rolledBack:[j.id]};
    } catch(e) {recoveryError=e;throw e;} finally {active=false;}
  }
  async function install({entry,filePath,candidateFingerprint,outputProbe}) {
    if(active || recoveryError)throw Error(recoveryError ? 'Repair recovery needs attention: '+recoveryError.message : 'A repair installation is already running');
    active=true;
    let j, undo=null, journalWritten=false;
    try {
      if(!entry || !await isAllowedPath(entry.filePath) || isPlaybackActive(entry.filePath))throw Error('Stop playback before using this repair copy');
      j={version:1,phase:'prepared',id:entry.id,entry:{...entry,mediaId:identity.idForPath(entry.filePath)},candidate:filePath,candidateFingerprint,
        retained:retainedPathFor(entry.filePath),output:newPathFor(entry.filePath)};
      await io.mkdir(path.dirname(j.retained),{recursive:true});
      await paths(j);
      if(!same(await stat(entry.filePath),entry.fingerprint) || !same(await stat(filePath),candidateFingerprint))throw Error('The original or repair copy changed; create a new repair copy');
      if(await stat(j.retained) || (j.output!==entry.filePath && await stat(j.output)))throw Error('A replacement or retained original already exists; review it first');
      try{await io.access(j.retained+'.conversion.json');throw Error('An original recovery record already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
      await sync(filePath);
      await save(file,j);journalWritten=true;
      if(isPlaybackActive(entry.filePath) || !await isAllowedPath(entry.filePath))throw Error('Playback or library location changed; original kept');
      await move(entry.filePath,j.retained,entry.fingerprint);
      await move(filePath,j.output,candidateFingerprint);
      await save(j.retained+'.conversion.json',{retainedAt:Date.now(),newPath:j.output,repair:true});
      undo=await identity.relocate(entry.filePath,j.output);
      await onChanged(entry.filePath,j.output,outputProbe);
      let ended=false;
      return {ok:true,verified:true,newPath:j.output,retainedPath:j.retained,originalDeleted:false,
        rollback:async()=>{if(ended)return;await rollback(j,undo);ended=true;active=false;},
        commit:async()=>{if(ended)return;await save(file,{...j,phase:'committed'});ended=true;active=false;await removeJournal();},
      };
    } catch(e) {
      if(journalWritten)try{await rollback(j,undo);}catch(r){recoveryError=r;e.message+='; original retained, recovery needs attention: '+r.message;}
      active=false;throw e;
    }
  }
  return {install,recover,get busy(){return active;}};
};
module.exports.sameFingerprint=same;
