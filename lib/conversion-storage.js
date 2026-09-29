// Check the branch that owns a file, rather than mergerfs's aggregate free space.
const fs = require('fs');
const path = require('path');
const {execFile}=require('child_process');
const {branchesFromFstab}=require('./storage-health');
const {parseDisks}=require('./system-stats');
function command(cmd,args) { return new Promise(resolve=>execFile(cmd,args,{timeout:4000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout)=>resolve({ok:!error,stdout:stdout||''}))); }
module.exports=function createConversionStorage({run=command,io=fs.promises,now=Date.now,poolMount='/mnt/media',ttlMs=10000}={}) {
  let cache=null,pending=null;
  const within=(file,root)=>file===root || file.startsWith(root+path.sep);
  async function disks({fresh=false}={}) {
    if(!fresh && cache && now()-cache.at<ttlMs)return cache;
    if(!pending)pending=(async()=>{
      const [df,fstab]=await Promise.all([run('df',['-B1','--output=source,size,used,avail,pcent,target']),io.readFile('/etc/fstab','utf8').catch(()=>'')]);
      const value={at:now(),rows:parseDisks(df.stdout),branches:branchesFromFstab(fstab),ok:df.ok};
      if(!value.rows.length && cache) return {...cache,ok:false};
      cache=value;return value;
    })().finally(()=>{pending=null;});
    return pending;
  }
  async function sourceDrive(file,snap) {
    if(!within(file,poolMount)) {
      const r=await run('df',['-B1','--output=source,size,used,avail,pcent,target',file]);
      const rows=parseDisks(r.stdout);
      // df may report a mount outside /media or /mnt (e.g. test files on /tmp).
      const m=r.stdout.trim().split('\n').pop()?.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
      return r.ok && m ? (rows[0] || {source:m[1],total:+m[2],used:+m[3],available:+m[4],percent:+m[5],mount:m[6]}) : null;
    }
    if(!snap.ok || !snap.branches.length)return null;
    const attr=await run('getfattr',['--absolute-names','--only-values','-n','user.mergerfs.fullpath',file]);
    const value=attr.stdout.trim();
    let branch=attr.ok && snap.branches.find(b=>within(value,b));
    if(!branch) {
      const relative=path.relative(poolMount,file);
      const matches=(await Promise.all(snap.branches.map(async b=>{try{await io.access(path.join(b,relative));return b;}catch{return null;}}))).filter(Boolean);
      if(matches.length!==1)return null;
      branch=matches[0];
    }
    // If a branch is unmounted, df reports the root disk. Never use that space.
    return snap.rows.find(d=>d.mount===branch) || null;
  }
  function warnings(snap) {
    return snap.rows.filter(d=>snap.branches.includes(d.mount) && d.percent>=90).map(d=>({...d,label:path.basename(d.mount),message:`${path.basename(d.mount)} is ${d.percent}% full. Conversion checks free space on this drive before each file.`}));
  }
  async function snapshot(filePath,{requiredBytes=0,fresh=false}={}) {
    const snap=await disks({fresh});
    const drive=filePath ? await sourceDrive(filePath,snap) : null;
    return {warnings:warnings(snap),current:filePath ? (drive ? {...drive,label:path.basename(drive.mount)||'System disk',known:true,requiredBytes} : {known:false,available:0,requiredBytes,message:'Cannot confirm the physical media drive; conversion will keep the original.'}) : null};
  }
  async function freeSpace(filePath) { const s=await snapshot(filePath,{fresh:true});return s.current; }
  async function scanHealth() {
    const snap=await disks({fresh:true});
    const unavailable=snap.branches.filter(b=>!snap.rows.some(d=>d.mount===b));
    return {degraded:!snap.ok || unavailable.length>0,unavailableBranches:unavailable,poolMount};
  }
  return {snapshot,freeSpace,scanHealth};
};
