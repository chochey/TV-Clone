// Failure holds survive the bounded activity log. A hold applies only to the
// exact regular file that failed; replacing it makes the new source eligible.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 25000, MAX_BYTES = 16 * 1024 * 1024;
const FIELDS = ['dev','ino','size','mtimeMs','ctimeMs'];
// A hold is matched on content alone. Rows still store -- and derive their id
// from -- the full stat, so existing review files stay valid, but dev/ino must
// not take part in the comparison: the library sits on a mergerfs union, which
// synthesises inode numbers and renumbers them on every mount, and st_dev names
// the mount rather than the file. Comparing them reported every unchanged source
// as "changed" after a reboot, which silently invalidated every held row. ctime
// is excluded too: it moves for metadata-only events (a chown, or a move between
// pool branches) that leave the media untouched.
const CONTENT = ['size','mtimeMs'];
const validPath = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0')
  && path.isAbsolute(value) && path.resolve(value) === value;
const validFingerprint = value => value && FIELDS.every(key => Number.isFinite(value[key]) && value[key] >= 0);
const sameFingerprint = (a,b) => validFingerprint(a) && validFingerprint(b) && CONTENT.every(key => a[key] === b[key]);
const clone = value => JSON.parse(JSON.stringify(value));
const bounded = (value,max) => String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').slice(0,max);
const idFor = entry => crypto.createHash('sha256').update(entry.filePath).update('\0')
  .update(JSON.stringify(FIELDS.map(key => entry.fingerprint[key]))).digest('hex').slice(0,32);
function stateError() {
  return Object.assign(new Error('Conversion review records are unavailable or inconsistent. Restore the review file before starting or retrying conversion.'),
    {code:'EREVIEWSTATE',status:503});
}
async function fileFingerprint(file,io=fs.promises) {
  try {
    const st=await io.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return Object.fromEntries(FIELDS.map(key => [key,st[key]]));
  } catch {return null;}
}
function describe(reason) {
  const details=bounded(reason,4096);
  const declared=Number(details.match(/declared container ([\d.]+)s/i)?.[1]);
  const spans=[...details.matchAll(/span ([\d.]+)s/g)].map(match=>Number(match[1])).filter(Number.isFinite);
  const measured=Math.max(0,...spans);
  const materialShortfall=declared>0 && measured>0 && declared-measured>60 && measured<declared/2;
  let category='other',summary='Conversion needs review. The original was kept.';
  if (materialShortfall || /file ended prematurely|premature end|truncat|source (?:container |declared .*?)?duration .*differs from/i.test(details)) {
    category='incomplete';summary='The source appears incomplete or its duration is inconsistent.';
  } else if (/source changed|source.*unavailable|not.*regular|symbolic link/i.test(details)) {
    category='source-changed';summary='The source changed or could not be safely checked.';
  } else if (/destination.*exists|destination appeared|duplicate|original.*already retained/i.test(details)) {
    category='duplicate';summary='An existing copy or retained original needs review.';
  } else if (/hdr|dolby vision|image subtitles|separate.*preset|expected one main video/i.test(details)) {
    category='unsupported';summary='This media needs a different conversion preset.';
  } else if (/source timestamp|backwards dts|missing timestamps/i.test(details)) {
    category='timestamps';summary='Source packet timestamps are inconsistent.';
  } else if (/source packet parser|invalid.*ebml|header missing/i.test(details)) {
    category='parser';summary='The source parser reported errors; their extent needs checking.';
  } else if (/decode|incomplete frame|ac-tex damaged|conversion reported media errors/i.test(details)) {
    category='decode';summary='Media decoding reported damage; its extent needs checking.';
  } else if (/drive|free space|storage|mount/i.test(details)) {
    category='storage';summary='The source drive or available space could not be confirmed.';
  } else if (/converted|output|verification|lost packets/i.test(details)) {
    category='verification';summary='The converted copy did not pass verification.';
  }
  return {category,summary,details};
}
const CATEGORIES=new Set(['other','incomplete','source-changed','duplicate','unsupported','timestamps','parser','decode','storage','verification']);
function validate(data) {
  if (!data || data.version!==1 || typeof data.seeded!=='boolean' || !Array.isArray(data.entries) || data.entries.length>MAX_ENTRIES) throw stateError();
  const paths=new Set(),ids=new Set();
  for (const row of data.entries) {
    if (!row || !validPath(row.filePath) || !validFingerprint(row.fingerprint) || !/^[a-f0-9]{32}$/.test(row.id)
        || row.id!==idFor(row) || paths.has(row.filePath) || ids.has(row.id)
        || typeof row.name!=='string' || row.name!==path.basename(row.filePath)
        || !CATEGORIES.has(row.category) || typeof row.summary!=='string' || row.summary.length>160
        || typeof row.details!=='string' || row.details.length>4096
        || (row.mediaId!==null && (typeof row.mediaId!=='string' || row.mediaId.length>128))
        || !Number.isFinite(row.firstFailedAt) || row.firstFailedAt<0 || !Number.isFinite(row.lastFailedAt)
        || row.lastFailedAt<row.firstFailedAt || !Number.isInteger(row.attempts) || row.attempts<1 || row.attempts>1000000) throw stateError();
    paths.add(row.filePath);ids.add(row.id);
  }
  return data;
}

module.exports=function createConversionReview({file,save,io=fs.promises,getFingerprint=name=>fileFingerprint(name,io)}) {
  if (!validPath(file) || typeof save!=='function') throw new Error('A private review file and strict save function are required');
  let state,signature=null,loaded=false,tail=Promise.resolve(),byPath=new Map(),byId=new Map();
  function index() {byPath=new Map(state.entries.map(row=>[row.filePath,row]));byId=new Map(state.entries.map(row=>[row.id,row]));}
  async function read() {
    let handle;
    try {
      handle=await io.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const st=await handle.stat();
      if (!st.isFile() || st.size>MAX_BYTES) throw stateError();
      const raw=await handle.readFile('utf8');
      if (Buffer.byteLength(raw)>MAX_BYTES) throw stateError();
      return validate(JSON.parse(raw));
    } catch(error) {if(error.code==='ENOENT')return null;throw stateError();}
    finally {await handle?.close();}
  }
  async function check(expectExisting=false) {
    const disk=await read();
    if (!loaded) {
      state=disk || {version:1,seeded:false,entries:[]};
      signature=disk ? JSON.stringify(disk) : null;loaded=true;index();
    }
    if (expectExisting && signature===null) throw stateError();
    if ((disk ? JSON.stringify(disk) : null)!==signature) throw stateError();
  }
  async function commit(next) {
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next,null,2))>MAX_BYTES) throw Object.assign(new Error('The conversion review list is full. Review existing entries before continuing.'),{code:'EREVIEWFULL',status:503});
    await save(file,clone(next));
    const disk=await read();
    if (!disk || JSON.stringify(disk)!==JSON.stringify(next)) throw stateError();
    state=next;signature=JSON.stringify(next);index();
  }
  function transaction(fn,{expectExisting=false}={}) {
    const next=tail.catch(()=>{}).then(async()=>{await check(expectExisting);return fn();});
    tail=next;return next;
  }
  function held(entry) {
    if (!loaded) throw stateError();
    const row=byPath.get(entry.filePath);
    return row && sameFingerprint(row.fingerprint,entry.fingerprint) ? row : null;
  }
  function failure(next,entry,result,at) {
    const old=next.entries.find(row=>row.filePath===entry.filePath);
    const same=old && sameFingerprint(old.fingerprint,entry.fingerprint);
    const row={id:idFor(entry),name:path.basename(entry.filePath),filePath:entry.filePath,
      mediaId:typeof entry.mediaId==='string'?entry.mediaId.slice(0,128):null,
      fingerprint:Object.fromEntries(FIELDS.map(key=>[key,entry.fingerprint[key]])),...describe(result.reason),
      firstFailedAt:same ? Math.min(old.firstFailedAt,at) : at,lastFailedAt:same ? Math.max(old.lastFailedAt,at) : at,
      attempts:same ? Math.min(1000000,old.attempts+1) : 1};
    if(old)next.entries[next.entries.indexOf(old)]=row;
    else {
      if(next.entries.length>=MAX_ENTRIES)throw Object.assign(new Error('The conversion review list is full. Review existing entries before continuing.'),{code:'EREVIEWFULL',status:503});
      next.entries.push(row);
    }
    return row;
  }
  async function seed(saved,getCurrentFingerprint=getFingerprint) {
    return transaction(async()=>{
      if(state.seeded)return {seeded:0};
      const next=clone(state),run=saved?.run;
      const entries=new Map((Array.isArray(run?.queue)?run.queue:[]).slice(0,MAX_ENTRIES)
        .filter(entry=>validPath(entry?.filePath)&&validFingerprint(entry.fingerprint)).map(entry=>[entry.filePath,entry]));
      const rows=[...(Array.isArray(run?.results)?run.results:[]),...(Array.isArray(saved?.history)?saved.history:[])].slice(0,400);
      const latest=new Map(),seen=new Set(),attempts=new Map();
      for(const row of rows) {
        if(!row || !validPath(row.filePath) || !Number.isFinite(row.at) || row.at<0 || (row.runId && row.runId!==run?.id))continue;
        const key=`${row.filePath}\0${row.runId||''}\0${row.at}`;
        if(seen.has(key))continue;seen.add(key);
        if(!attempts.has(row.filePath))attempts.set(row.filePath,[]);
        attempts.get(row.filePath).push(row);
        if(!latest.has(row.filePath)||latest.get(row.filePath).at<row.at)latest.set(row.filePath,row);
      }
      let count=0;
      for(const row of latest.values()) {
        const entry=entries.get(row.filePath);
        if(!entry || (row.ok!==false && row.outcome!=='review') || row.ok || row.outcome==='converted' || row.outcome==='skipped'
            || !sameFingerprint(entry.fingerprint,await getCurrentFingerprint(entry.filePath)))continue;
        for(const attempt of attempts.get(row.filePath).sort((a,b)=>a.at-b.at)) {
          if((attempt.ok===false||attempt.outcome==='review') && attempt.outcome!=='skipped')failure(next,entry,{reason:attempt.reason},attempt.at);
        }
        count++;
      }
      next.seeded=true;await commit(next);return {seeded:count};
    },{expectExisting:saved?.reviewInitialized===true});
  }
  async function record(entry,result,{at=Date.now()}={}) {
    return transaction(async()=>{
      if(result.ok || result.skipped || result.deferred || !validPath(entry.filePath) || !validFingerprint(entry.fingerprint)
          || !sameFingerprint(entry.fingerprint,await getFingerprint(entry.filePath)))return {recorded:false};
      if(!Number.isFinite(at)||at<0)throw new Error('Invalid conversion failure timestamp');
      const next=clone(state),row=failure(next,entry,result,at);
      await commit(next);return {recorded:true,id:row.id};
    });
  }
  async function complete(entry,{priorReviewId}={}) {
    return transaction(async()=>{
      const current=byPath.get(entry.filePath);
      // A verified replacement can retire the older failure at this pathname,
      // but only the exact hold captured when that replacement was queued.
      // A later failure for another file identity must remain untouched.
      const row=held(entry) || (/^[a-f0-9]{32}$/.test(priorReviewId || '') && current?.id===priorReviewId ? current : null);
      if(!row)return {removed:false};
      const next=clone(state);next.entries=next.entries.filter(item=>item.id!==row.id);
      await commit(next);return {removed:true};
    });
  }
  const ready=options=>transaction(()=>({ok:true,initialized:state.seeded}),options);
  const get=id=>transaction(()=>{const row=byId.get(id);return row?clone(row):null;});
  const snapshot=({offset=0,limit=100}={})=>transaction(()=>{
    offset=Number.isInteger(offset)&&offset>=0?offset:0;limit=Number.isInteger(limit)?Math.min(200,Math.max(1,limit)):100;
    const entries=state.entries.slice().sort((a,b)=>b.lastFailedAt-a.lastFailedAt||a.name.localeCompare(b.name));
    return {ok:true,total:entries.length,offset,limit,initialized:state.seeded,entries:clone(entries.slice(offset,offset+limit))};
  });
  return {ready,seed,record,complete,get,snapshot,isBlocked:entry=>!!held(entry),
    priorIdForPath:name=>{if(!loaded)throw stateError();return byPath.get(name)?.id || null;},
    allowsRetry:(entry,id)=>held(entry)?.id===id,flush:()=>tail};
};
module.exports.describe=describe;
module.exports.sameFingerprint=sameFingerprint;
module.exports.fileFingerprint=fileFingerprint;
module.exports.MAX_ENTRIES=MAX_ENTRIES;
module.exports.MAX_BYTES=MAX_BYTES;
