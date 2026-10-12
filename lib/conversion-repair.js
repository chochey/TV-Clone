// Repair copies are isolated from normal conversion: no source rename, delete,
// profile mutation or automatic adoption. Only a fully verified hidden copy
// can be handed to the administrator's separately guarded installation flow.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn,execFile} = require('child_process');
const {cpuList,inspectSource,buildCompatibleArgs,compatibleStreamPlan,verifyCompatibleAudio} = require('./conversion-encode');
const {createPacketCollector,validateSourcePackets,verifyPacketPreservation,verifyDecodedSample,
  verifyDecodeDiagnostics} = require('./conversion-verification');
const {fileFingerprint,sameFingerprint} = require('./conversion-review');
const {withinSchedule} = require('./conversion-queue');

const ID = /^[a-f0-9]{32}$/;
const MAX_STATE = 2*1024*1024, MAX_RECORDS = 200, MAX_DIAGNOSTICS = 65536;
const ACTIVE = new Set(['running','stopping','applying']);
const STATUS = new Set([...ACTIVE,'ready','failed','cancelled','interrupted','installed']);
const incomplete = text => /file ended prematurely|premature end|truncat(?:ed|ion)|unexpected end of file/i.test(text);
const fail = (status,message,code='EREPAIR') => Object.assign(new Error(message),{status,code});
const copy = value => JSON.parse(JSON.stringify(value));
const validPath = value => typeof value==='string' && path.isAbsolute(value) && path.resolve(value)===value
  && value.length<=4096 && !/[\x00-\x1f\x7f]/.test(value);
const fingerprintValid = value => value && ['dev','ino','size','mtimeMs','ctimeMs'].every(k=>Number.isFinite(value[k])&&value[k]>=0);
const progress = () => ({percent:0,seconds:0,duration:0,speed:''});
const candidatePath = entry => path.join(path.dirname(entry.filePath),'.conversion-repairs',entry.id,'candidate.mp4');
const browserProbe = probe => Array.isArray(probe?.streams)&&probe.streams.length<=40
  && probe.streams.filter(s=>s.codec_type==='video').length===1
  && probe.streams.find(s=>s.codec_type==='video')?.codec_name==='h264'
  && ['yuv420p','yuvj420p'].includes(probe.streams.find(s=>s.codec_type==='video')?.pix_fmt)
  && probe.streams.find(s=>s.codec_type==='audio')?.channels===2
  && probe.streams.filter(s=>s.codec_type==='audio').every(s=>s.codec_name==='aac');

// Repair-only policy: bounded parser/decoder diagnostics are retained for
// human review, but every existing timestamp and declared-duration check is
// still mandatory. Explicit truncation diagnostics never qualify for repair.
function validateRepairSource(probe,inventory) {
  if (inventory.warningBytes>MAX_DIAGNOSTICS || incomplete(inventory.warnings)) {
    throw fail(422,'The source appears incomplete or has too many media errors. Obtain a complete copy; the original was kept.');
  }
  return validateSourcePackets(probe,{...inventory,warningBytes:0,warnings:''});
}
function repairArgs(source,output,probe,settings) {
  // Re-encode video even if the damaged source is H.264. Preserve every audio
  // track and add the normal browser stereo track when the preset requires it.
  const forceVideo={...probe,streams:probe.streams.map(s=>s.codec_type==='video'&&!s.disposition?.attached_pic?{...s,codec_name:'repair'}:s)};
  const args=buildCompatibleArgs(source,output,forceVideo,settings);
  args[args.indexOf('-map_chapters')+1]='0';
  args.splice(args.indexOf('-sn'),1);
  args.splice(args.indexOf('-y'),1,'-n');
  const plan=compatibleStreamPlan(forceVideo).map(row=>({...row,copied:false}));
  for(let i=0;i<args.length-1;i++) if (/^-c:a:\d+$/.test(args[i])) args[i+1]='aac';
  args.pop();
  args.push('-ac:a:0','2','-b:a:0','192k','-fps_mode:v','passthrough');
  probe.streams.filter(s=>s.codec_type==='subtitle').forEach((track,i)=>{
    args.push('-map',`0:${track.index}`,'-c:s','mov_text');
    for(const key of ['language','title']) if(track.tags?.[key]) args.push(`-metadata:s:s:${i}`,`${key}=${track.tags[key]}`);
    const flags=['default','forced'].filter(key=>track.disposition?.[key]);
    args.push(`-disposition:s:${i}`,flags.join('+')||'0');
  });
  args.push(output);
  return {args,plan};
}
function subtitleCues(text) {
  if (!text.trim()) return [];
  return text.replace(/\r/g,'').trim().split(/\n\s*\n/).map(block=>{
    const lines=block.split('\n'); if(/^\d+$/.test(lines[0]))lines.shift();
    const match=/^(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines.shift()||'');
    if(!match)throw fail(422,'Subtitle timing could not be verified; the original was kept.');
    const time=at=>Number(match[at])*3600+Number(match[at+1])*60+Number(match[at+2])+Number(match[at+3])/1000;
    return {start:time(1),end:time(5),text:lines.join('\n')};
  });
}
function verifyChapters(source,output) {
  const before=source.chapters||[],after=output.chapters||[];
  if(before.length!==after.length)throw fail(422,'Chapter information was not preserved; the original was kept.');
  before.forEach((chapter,i)=>{
    const actual=after[i];
    if(![chapter.start_time,chapter.end_time,actual.start_time,actual.end_time].every(value=>Number.isFinite(Number(value)))
        || Number(chapter.end_time)<Number(chapter.start_time)||Number(actual.end_time)<Number(actual.start_time)
        || String(chapter.tags?.title||'')!==String(actual.tags?.title||'')
        || Math.abs(Number(chapter.start_time)-Number(actual.start_time))>0.1
        || Math.abs(Number(chapter.end_time)-Number(actual.end_time))>0.1) {
      throw fail(422,'Chapter information was not preserved; the original was kept.');
    }
  });
}
function candidateWarnings(text,probe) {
  return text.split('\n').filter(line=>{
    const match=/^Unsupported codec with id 98314 for input stream (\d+)\s*$/.exec(line.trim());
    const stream=match&&probe.streams?.find(s=>s.index===Number(match[1]));
    // FFmpeg's QuickTime chapter table is binary metadata, not an audio/video
    // decoder. This exact ffprobe warning is harmless only for that table;
    // chapter titles and boundaries are separately verified in full.
    return !(match&&probe.chapters?.length&&stream?.codec_type==='data'&&stream.codec_name==='bin_data');
  }).join('\n').trim();
}

module.exports = function createConversionRepair({review,stateFile,save,getConfig=()=>({}),getLimits=getConfig,
  isConversionBusy=()=>false,isPlaybackActive=()=>false,isAllowedPath,
  storage=require('./conversion-storage')(),beforeReady=async()=>{},
  spawnChild=spawn,now=Date.now,commandTimeoutMs=6*60*60*1000,maxJobMs=12*60*60*1000,monitorMs=500}) {
  if(!review || typeof review.get!=='function' || typeof save!=='function' || !validPath(stateFile)
      || typeof isAllowedPath!=='function')throw new Error('Private repair state, review registry and library guard are required');
  let state={version:1,records:[]},loaded=null,writeTail=Promise.resolve(),task=null;
  let busy=false,current=null,cancelled=false,stopReason='',child=null,killTimer=null;

  function message(error,record=current) {
    let text=String(error?.message||'Repair could not be verified. The original was kept.');
    for(const file of [record?.entry?.filePath,record?.candidatePath]) if(file)text=text.split(file).join(path.basename(file));
    if(record?.entry?.filePath)text=text.split(path.dirname(record.entry.filePath)).join('[library]');
    text=text.split(stateFile).join('[private repair state]');
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,2000);
  }
  function persist() {
    const value=copy(state);
    if(Buffer.byteLength(JSON.stringify(value))>MAX_STATE)return Promise.reject(fail(503,'Private repair state is full. Review existing candidates before continuing.'));
    const next=writeTail.catch(()=>{}).then(()=>save(stateFile,value));writeTail=next;return next;
  }
  async function ready() {
    if(loaded)return loaded;
    loaded=(async()=>{
      const recovery=await beforeReady();
      let handle;
      try {
        handle=await fs.promises.open(stateFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        const st=await handle.stat();if(!st.isFile()||st.size>MAX_STATE)throw Error('Invalid state');
        const raw=await handle.readFile('utf8');if(Buffer.byteLength(raw)>MAX_STATE)throw Error('Invalid state');
        const parsed=JSON.parse(raw),seen=new Set();
        if(parsed?.version!==1||!Array.isArray(parsed.records)||parsed.records.length>MAX_RECORDS)throw Error('Invalid state');
        for(const record of parsed.records) {
          if(!ID.test(record?.reviewId)||seen.has(record.reviewId)||!STATUS.has(record.status)
              || record.entry?.id!==record.reviewId||!validPath(record.entry.filePath)||!fingerprintValid(record.entry.fingerprint)
              || record.candidatePath!==candidatePath(record.entry)||typeof record.stage!=='string'||typeof record.error!=='string'
              || !Array.isArray(record.warnings)||record.warnings.length>32||record.warnings.some(s=>typeof s!=='string'||s.length>4096)
              || !Number.isFinite(record.updatedAt)||!record.progress||!Number.isFinite(record.progress.percent)
              || (record.status==='ready'&&(!fingerprintValid(record.candidateFingerprint)||!browserProbe(record.outputProbe))))throw Error('Invalid state');
          seen.add(record.reviewId);
        }
        state=parsed;
      } catch(error) {
        if(error.code!=='ENOENT')throw fail(503,'Repair records are unavailable or inconsistent. Restore the private repair state before retrying.','EREPAIRSTATE');
      } finally {await handle?.close();}
      let changed=false;
      const recovered=new Set(recovery?.rolledBackReviewIds||recovery?.rolledBack||[]);
      for(const record of state.records) if(ACTIVE.has(record.status)||recovered.has(record.reviewId)) {
        record.status='interrupted';record.stage='Interrupted';record.error='Repair was interrupted. The original was kept; create a new repair copy.';
        record.updatedAt=now();changed=true;
      }
      if(changed)await persist();
      return {ok:true};
    })();
    return loaded;
  }
  function publicRecord(record) {
    return {reviewId:record.reviewId,name:path.basename(record.entry.filePath),sourceName:path.basename(record.entry.filePath),
      status:record.status,stage:record.stage,progress:{...record.progress},error:record.error,warnings:[...record.warnings],
      previewReady:record.status==='ready',updatedAt:record.updatedAt};
  }
  async function snapshot() {
    await ready();
    const record=current||[...state.records].sort((a,b)=>b.updatedAt-a.updatedAt)[0];
    return {busy,reviewId:record?.reviewId||null,name:record?path.basename(record.entry.filePath):'',status:record?.status||'idle',
      stage:record?.stage||'',progress:{...(record?.progress||progress())},error:record?.error||'',
      warnings:[...(record?.warnings||[])],candidate:record?.status==='ready'?{verified:true,reviewId:record.reviewId}:null,
      entries:state.records.map(publicRecord)};
  }
  async function controls(file) {
    if(await isConversionBusy())throw fail(409,'Stop the normal conversion queue before repairing a copy.');
    if(await isPlaybackActive(file))throw fail(409,'Playback is active. Repair will wait until playback stops; the original was kept.','EPLAYBACK');
  }
  async function source(entry) {
    if(!entry||!ID.test(entry.id)||!validPath(entry.filePath)||!fingerprintValid(entry.fingerprint))throw fail(404,'This review entry is unavailable.');
    const real=await fs.promises.realpath(entry.filePath);
    const fp=await fileFingerprint(entry.filePath);
    if(real!==entry.filePath||!sameFingerprint(fp,entry.fingerprint)||!await isAllowedPath(entry.filePath,{realPath:real,entry,recovery:false})) {
      throw fail(409,'The source changed or is outside the linked library. Refresh Needs review; the original was kept.');
    }
    return fp;
  }
  async function directory(dir,create=false) {
    if(create) {try {await fs.promises.mkdir(dir,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
    const st=await fs.promises.lstat(dir);
    if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.geteuid()||(st.mode&0o777)!==0o700
        ||await fs.promises.realpath(dir)!==dir)throw fail(409,'The private repair folder is unsafe; the original was kept.');
    return st;
  }
  async function space(entry) {
    const drive=await storage.freeSpace(entry.filePath),settings=getLimits();
    const required=Math.max(entry.fingerprint.size*3,(Number(settings.minFreeSpaceGB)||0)*1e9+entry.fingerprint.size*3);
    if(!drive?.known||!Number.isFinite(drive.available))throw fail(409,'The physical drive free space could not be confirmed. The original was kept.','ESTORAGE');
    if(drive.available<required)throw fail(409,'There is not enough confirmed space for a repair copy and the required free-space reserve. The original was kept.','ESTORAGE');
    return required;
  }
  function checkCancelled() {
    if(cancelled)throw fail(409,stopReason||'Repair stopped. The original was kept.','ECANCELLED');
    if(current?.deadlineAt&&now()>=current.deadlineAt)throw fail(422,'Repair exceeded its overall processing deadline. The original was kept.');
  }
  function terminate(reason) {
    cancelled=true;stopReason=reason;
    if(child) {
      const active=child;try{active.kill('SIGCONT');}catch{}try{active.kill('SIGTERM');}catch{}
      clearTimeout(killTimer);killTimer=setTimeout(()=>{try{active.kill('SIGKILL');}catch{}},2000);killTimer.unref?.();
    }
  }
  function warning(record,text) {
    text=message({message:text},record).trim();
    if(text&&!record.warnings.includes(text)&&record.warnings.length<32)record.warnings.push(text.slice(0,4096));
  }
  async function stage(record,text,percent) {
    checkCancelled();await controls(record.entry.filePath);await source(record.entry);
    record.stage=text;record.progress.percent=percent;record.progress.seconds=0;record.updatedAt=now();await persist();checkCancelled();
  }
  async function run(command,args,{stdoutLimit=0,onStdout,onStderr,sourceWarnings=false,record=current}={}) {
    checkCancelled();await controls(record.entry.filePath);
    const settings=getLimits();let affinity=cpuList(settings.cpuCores);
    const threads=Math.max(1,Math.round(Math.min(Number(settings.cpuCores)||2,Number(settings.ffmpegThreads)||2,6)));
    if(command==='ffmpeg')args=['-threads',String(threads),...args];
    return new Promise((resolve,reject)=>{
      let output='',diagnostics='',bytes=0,warningBytes=0,warningTail='',pending='',settled=false,error=null,checking=false,lastSave=now(),lastSpace=now(),active;
      const stop=why=>{if(!error)error=why;try{active?.kill('SIGCONT');}catch{}try{active?.kill('SIGTERM');}catch{}
        clearTimeout(killTimer);killTimer=setTimeout(()=>{try{active?.kill('SIGKILL');}catch{}},2000);killTimer.unref?.();};
      const finish=(err)=>{
        if(settled)return;settled=true;clearInterval(monitor);clearTimeout(deadline);clearTimeout(killTimer);killTimer=null;
        if(child===active)child=null;
        if(err||error||cancelled)reject(error|| (cancelled?fail(409,stopReason,'ECANCELLED'):err));
        else resolve({stdout:output,stderr:diagnostics,warningBytes});
      };
      let monitor,deadline;
      try {active=spawnChild('taskset',['-c',affinity,'nice','-n',String(Math.min(19,Math.max(0,Number(settings.niceness??19)||0))),'ionice','-c','3',command,...args],{stdio:['ignore','pipe','pipe']});child=active;}
      catch(err){finish(err);return;}
      active.stdout.on('data',chunk=>{
        try {
          if(onStdout)onStdout(chunk);
          else if(stdoutLimit) {bytes+=chunk.length;if(bytes>stdoutLimit)throw Error('Media verification output exceeded its safe limit');output+=String(chunk);}
          else {
            pending+=String(chunk);let i;
            while((i=pending.indexOf('\n'))>=0) {
              const line=pending.slice(0,i);pending=pending.slice(i+1);const [key,value]=line.split('=');
              if(key==='out_time_us'&&Number.isFinite(Number(value)))record.progress.seconds=Number(value)/1e6;
              if(key==='speed')record.progress.speed=value.slice(0,32);
              if(record.stage==='Creating repair copy'&&record.progress.duration>0)record.progress.percent=Math.min(69,20+record.progress.seconds/record.progress.duration*50);
            }
            if(pending.length>65536)throw Error('Invalid media progress output');
          }
        }catch(err){stop(err);}
      });
      active.stderr.on('data',chunk=>{
        warningBytes+=chunk.length; if(diagnostics.length<4096)diagnostics+=String(chunk).slice(0,4096-diagnostics.length);
        if(sourceWarnings&&incomplete(warningTail+String(chunk)))stop(fail(422,'The source appears incomplete. Obtain a complete copy; the original was kept.'));
        warningTail=(warningTail+String(chunk)).slice(-256);
        try {onStderr?.(chunk);}catch(err){stop(err);}
        if(warningBytes>MAX_DIAGNOSTICS)stop(Error('Media diagnostics exceeded the safe repair limit'));
      });
      active.stdout.on('error',err=>stop(err));active.stderr.on('error',err=>stop(err));
      active.on('error',err=>finish(err));
      active.on('close',code=>{
        if(sourceWarnings&&diagnostics.trim())warning(record,diagnostics);
        finish(code===0?null:Error('Media processing could not finish. The source may be damaged; the original was kept.'));
      });
      monitor=setInterval(async()=>{
        if(checking||settled)return;checking=true;
        try {
          await controls(record.entry.filePath);if(settled)return;checkCancelled();
          if(now()-lastSave>=5000) {lastSave=now();record.updatedAt=now();await persist();}
          if(now()-lastSpace>=10000) {lastSpace=now();await space(record.entry);}
          const next=cpuList(getLimits().cpuCores);
          if(next!==affinity&&active.pid)execFile('taskset',['-apc',next,String(active.pid)],{timeout:3000,maxBuffer:4096},err=>{if(!err)affinity=next;});
        }catch(err){stop(err);}finally{checking=false;}
      },monitorMs);
      const remaining=record.deadlineAt?Math.max(1,record.deadlineAt-now()):commandTimeoutMs;
      deadline=setTimeout(()=>stop(Error('Repair exceeded its processing deadline. The original was kept.')),Math.min(commandTimeoutMs,remaining));
    });
  }
  async function probe(file) {
    const result=await run('ffprobe',['-v','warning','-show_format','-show_streams','-show_chapters','-of','json',file],{stdoutLimit:8*1024*1024,sourceWarnings:file===current.entry.filePath});
    const parsed=JSON.parse(result.stdout),warnings=file===current.entry.filePath?result.stderr:candidateWarnings(result.stderr,parsed);
    if(file!==current.entry.filePath&&(warnings||result.warningBytes>4096))throw Error('The candidate parser reported errors: '+(warnings.split('\n')[0]||'diagnostic limit exceeded'));
    if(incomplete(result.stderr))throw fail(422,'The source appears incomplete. Obtain a complete copy; the original was kept.');
    return parsed;
  }
  async function packets(file,probeData,original) {
    const collector=createPacketCollector(probeData);
    await run('ffprobe',['-v','warning','-show_packets','-show_entries','packet=stream_index,pts_time,dts_time,duration_time','-of','compact=p=0:nk=0',file],
      {onStdout:chunk=>collector.write(chunk),onStderr:chunk=>collector.warn(chunk),sourceWarnings:original});
    const inventory=collector.finish();
    if(!original&&inventory.warningBytes<=4096) {
      inventory.warnings=candidateWarnings(inventory.warnings,probeData);inventory.warningBytes=Buffer.byteLength(inventory.warnings);
    }
    return inventory;
  }
  async function fullDecode(file,stream,inventory,original) {
    let pending='',decoded={frame:0,out_time_us:0},errors='';
    const result=await run('ffmpeg',['-v','error','-nostdin',...(!original?['-xerror']:[]),'-i',file,'-map',`0:${stream.index}`,
      ...(stream.codec_type==='audio'?['-af','asetpts=N/SR/TB']:['-fps_mode','passthrough']),'-progress','pipe:1','-nostats','-f','null','-'],{
      sourceWarnings:original,onStdout:chunk=>{
        pending+=String(chunk);let i;
        while((i=pending.indexOf('\n'))>=0) {const line=pending.slice(0,i);pending=pending.slice(i+1);const [key,value]=line.split('=');
          if(Object.hasOwn(decoded,key)&&Number.isFinite(Number(value)))decoded[key]=Math.max(decoded[key],Number(value));}
        if(pending.length>65536)throw Error('Invalid decode progress output');
      },onStderr:chunk=>{if(errors.length<MAX_DIAGNOSTICS)errors+=String(chunk).slice(0,MAX_DIAGNOSTICS-errors.length);},
    });
    if(incomplete(result.stderr))throw fail(422,'The source appears incomplete. Obtain a complete copy; the original was kept.');
    if(!original)verifyDecodeDiagnostics(errors,stream,0);
    verifyDecodedSample(`frame=${decoded.frame}\nout_time_us=${decoded.out_time_us}`,stream,0,inventory.duration);
    if(stream.codec_type==='video'&&decoded.frame!==inventory.packets)throw fail(422,'Video frames could not all be decoded. A repair copy cannot be verified; the original was kept.');
    if(stream.codec_type==='audio'&&Math.abs(decoded.out_time_us/1e6-inventory.duration)>0.25)throw fail(422,'Audio could not be decoded for its full measured duration; the original was kept.');
    return decoded;
  }
  async function subtitles(file,probeData) {
    const result=[];
    for(const stream of probeData.streams.filter(s=>s.codec_type==='subtitle')) {
      const text=await run('ffmpeg',['-v','error','-nostdin','-i',file,'-map',`0:${stream.index}`,'-c:s','srt','-f','srt','pipe:1'],{stdoutLimit:2*1024*1024});
      if(text.stderr.trim())throw fail(422,'Subtitles could not be read completely; the original was kept.');
      result.push({stream,cues:subtitleCues(text.stdout)});
    }
    return result;
  }
  async function sync(dir) {const handle=await fs.promises.open(dir,'r');try{await handle.sync();}finally{await handle.close();}}
  async function runJob(record) {
    let temp=null,published=false;
    try {
      await stage(record,'Checking source',0);await space(record.entry);
      const original=await probe(record.entry.filePath);inspectSource(original);
      if(original.streams.length>32||original.streams.some(s=>['attachment','data'].includes(s.codec_type)||s.disposition?.attached_pic))throw fail(422,'Additional data, artwork or attachment streams need a separate repair preset. The original was kept.');
      await stage(record,'Checking complete source packets',5);
      const before=await packets(record.entry.filePath,original,true),duration=validateRepairSource(original,before);record.progress.duration=duration;
      await stage(record,'Checking complete source decoding',10);
      const sourceDecode=new Map();
      for(const stream of original.streams.filter(s=>['video','audio'].includes(s.codec_type)&&!s.disposition?.attached_pic)) {
        sourceDecode.set(stream.index,await fullDecode(record.entry.filePath,stream,before.streams.find(s=>s.index===stream.index),true));
      }
      const sourceSubs=await subtitles(record.entry.filePath,original);
      await source(record.entry);await controls(record.entry.filePath);await space(record.entry);
      const base=path.dirname(path.dirname(record.candidatePath)),dir=path.dirname(record.candidatePath);
      await directory(base,true);await directory(dir,true);
      try {await fs.promises.lstat(record.candidatePath);throw fail(409,'A repair candidate already exists. Verify or review it before creating another.');}catch(err){if(err.code!=='ENOENT')throw err;}
      temp=path.join(dir,`.candidate.${crypto.randomBytes(12).toString('hex')}.mp4`);
      await stage(record,'Creating repair copy',20);
      const settings=getLimits(),{args,plan}=repairArgs(record.entry.filePath,temp,original,settings);
      const conversion=await run('ffmpeg',args,{sourceWarnings:true});
      if(incomplete(conversion.stderr))throw fail(422,'The source appears incomplete; a shorter repair copy cannot be accepted. The original was kept.');
      await stage(record,'Verifying complete candidate',70);
      const output=await probe(temp),after=await packets(temp,output,false),tracks=verifyPacketPreservation(before,after,plan,output);
      verifyCompatibleAudio(original,output);
      if(Buffer.byteLength(JSON.stringify(output))>128*1024)throw Error('The candidate metadata exceeds the safe repair state limit.');
      if(!browserProbe(output))throw Error('The candidate does not match the browser-compatible preset.');
      for(const {stream,packets:span} of tracks) {
        const decoded=await fullDecode(temp,stream,span,false),sourceResult=sourceDecode.get(plan[tracks.findIndex(t=>t.stream.index===stream.index)].sourceIndex);
        if(stream.codec_type==='video'&&decoded.frame!==sourceResult.frame)throw Error('The candidate lost video frames; the original was kept.');
        if(stream.codec_type==='audio'&&Math.abs(decoded.out_time_us-sourceResult.out_time_us)>100000)throw Error('The candidate audio duration differs from the complete source decode; the original was kept.');
      }
      verifyChapters(original,output);
      const outputSubs=await subtitles(temp,output);
      if(sourceSubs.length!==outputSubs.length)throw Error('The candidate lost subtitle streams; the original was kept.');
      sourceSubs.forEach((row,i)=>{
        const next=outputSubs[i];
        if(String(row.stream.tags?.language||'und')!==String(next.stream.tags?.language||'und')||row.cues.length!==next.cues.length
            || row.cues.some((cue,n)=>cue.text!==next.cues[n].text||Math.abs(cue.start-next.cues[n].start)>0.1||Math.abs(cue.end-next.cues[n].end)>0.1)) {
          throw Error('The candidate subtitle text or timing changed; the original was kept.');
        }
      });
      await stage(record,'Saving verified candidate',95);await space(record.entry);
      const handle=await fs.promises.open(temp,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {if(!(await handle.stat()).isFile())throw Error('Candidate is not a regular file');await handle.sync();}finally{await handle.close();}
      await fs.promises.link(temp,record.candidatePath);published=true;await fs.promises.unlink(temp);temp=null;await sync(dir);
      await source(record.entry);await controls(record.entry.filePath);checkCancelled();
      record.candidateFingerprint=await fileFingerprint(record.candidatePath);record.outputProbe=output;
      record.status='ready';record.stage='Verified repair copy ready';record.progress.percent=100;record.error='';record.updatedAt=now();await persist();checkCancelled();
    }catch(error) {
      record.status=cancelled||error.code==='ECANCELLED'?'cancelled':'failed';record.stage=record.status==='cancelled'?'Stopped':'Needs review';
      record.error=message(error,record);record.updatedAt=now();record.candidateFingerprint=null;record.outputProbe=null;
      if(published)try{await fs.promises.unlink(record.candidatePath);await sync(path.dirname(record.candidatePath));}catch{}
      try{await persist();}catch{record.error='Repair state could not be saved. The original was kept; the candidate is unavailable.';}
    }finally {if(temp)try{await fs.promises.unlink(temp);}catch{}current=null;busy=false;child=null;clearTimeout(killTimer);killTimer=null;}
    return publicRecord(record);
  }
  async function start(id) {
    if(typeof id!=='string'||!ID.test(id))throw fail(400,'Choose a valid Needs review entry.');
    if(busy)throw fail(409,'A repair or installation is already in progress.');
    busy=true;cancelled=false;stopReason='';
    try {
      await ready();await controls();
      const config=getConfig();if(config.enabled===false)throw fail(409,'Enable conversion before creating a repair copy.');
      if(!withinSchedule(config.schedule))throw fail(409,'Repair is outside the configured conversion schedule.');
      const entry=await review.get(id);await source(entry);await controls(entry.filePath);await space(entry);
      checkCancelled();
      const previous=state.records.find(record=>record.reviewId===id);
      if(previous?.status==='ready')throw fail(409,'A verified repair copy is already ready for this entry.');
      if(!previous&&state.records.length>=MAX_RECORDS)throw fail(409,'The private repair list is full. Review existing candidates before creating more.');
      const record={reviewId:id,entry:copy(entry),candidatePath:candidatePath(entry),candidateFingerprint:null,outputProbe:null,
        status:'running',stage:'Checking source',progress:progress(),warnings:[],error:'',updatedAt:now(),deadlineAt:now()+maxJobMs};
      if(previous)state.records[state.records.indexOf(previous)]=record;else state.records.push(record);
      current=record;await persist();task=runJob(record);void task.catch(()=>{});
      return {ok:true,reviewId:id,status:'running'};
    }catch(error){busy=false;current=null;throw error.status?error:fail(503,'Could not safely start repair. The original was kept.');}
  }
  async function stop() {
    if(!busy)return {ok:true,status:'idle'};
    if(current?.status==='applying')throw fail(409,'Replacement installation is finishing; it cannot be interrupted here.');
    terminate('Repair stopped by you. The original was kept.');
    if(current){current.status='stopping';current.stage='Stopping';current.updatedAt=now();await persist();}
    return {ok:true,status:'stopping'};
  }
  async function candidate(id) {
    await ready();if(typeof id!=='string'||!ID.test(id))throw fail(400,'Choose a valid repair candidate.');
    const record=state.records.find(record=>record.reviewId===id);
    if(!record||record.status!=='ready')throw fail(409,'A verified repair copy is not available for this entry.');
    const entry=await review.get(id);
    if(!entry||!sameFingerprint(entry.fingerprint,record.entry.fingerprint)||entry.filePath!==record.entry.filePath)throw fail(409,'The review source changed. The repair copy cannot be used.');
    await source(entry);await directory(path.dirname(path.dirname(record.candidatePath)));await directory(path.dirname(record.candidatePath));
    const real=await fs.promises.realpath(record.candidatePath),fp=await fileFingerprint(record.candidatePath),st=await fs.promises.lstat(record.candidatePath);
    if(real!==record.candidatePath||st.nlink!==1||!sameFingerprint(fp,record.candidateFingerprint))throw fail(409,'The verified repair copy changed. Create a new repair copy before preview or replacement.');
    // The library guard is re-run after asynchronous candidate checks.
    await source(entry);
    return {entry:copy(entry),filePath:record.candidatePath,candidateFingerprint:copy(fp),fingerprint:copy(fp),size:fp.size,outputProbe:copy(record.outputProbe)};
  }
  async function apply(id,installCallback) {
    if(typeof installCallback!=='function')throw fail(400,'A verified replacement installer is required.');
    if(busy)throw fail(409,'A repair or installation is already in progress.');
    busy=true;let record,installed=null,entry;
    try {
      await ready();await controls();const descriptor=await candidate(id);entry=descriptor.entry;await controls(entry.filePath);
      record=state.records.find(row=>row.reviewId===id);current=record;record.status='applying';record.stage='Installing verified replacement';record.updatedAt=now();await persist();
      installed=await installCallback(descriptor);
      if(!installed?.ok||installed.verified!==true)throw Error('Replacement installation was not confirmed as verified.');
      if(!(await review.complete(entry))?.removed)throw Error('The source review changed before installation was recorded.');
      record.status='installed';record.stage='Verified replacement installed';record.error='';record.updatedAt=now();await persist();
      let cleanupWarning='';
      if(typeof installed.commit==='function')try{await installed.commit();}catch{cleanupWarning='Replacement saved with original retained; installation record needs recovery before further conversions.';warning(record,cleanupWarning);try{await persist();}catch{}}
      return {ok:true,status:'installed',reviewId:id,...(cleanupWarning?{cleanupWarning}:{})};
    }catch(error) {
      let recoveryFailed=false;
      if(installed) {
        if(typeof installed.rollback==='function')try {
          await installed.rollback();
          const fp=await fileFingerprint(entry.filePath);
          if(!fp||!await isAllowedPath(entry.filePath,{realPath:await fs.promises.realpath(entry.filePath),entry,recovery:true}))throw Error('Source recovery needs attention');
          await review.record({...entry,fingerprint:fp},{ok:false,reason:'Repair installation interrupted; original restored'});
        }catch{recoveryFailed=true;}else recoveryFailed=true;
      }
      if(record){record.status=recoveryFailed||installed?'failed':'ready';record.stage=recoveryFailed?'Recovery needs attention':installed?'Create a new repair after recovery':'Verified repair copy ready';
        record.error=recoveryFailed?'Replacement recovery needs attention. The retained original was kept; do not retry until recovery is checked.':message(error,record);record.updatedAt=now();
        try{await persist();}catch{record.status='failed';record.error='Replacement state could not be saved. Check the retained original before retrying.';}}
      throw fail(503,record?.error||message(error));
    }finally {current=null;busy=false;}
  }
  return {ready,start,stop,snapshot,candidate,preview:candidate,apply,wait:()=>task||Promise.resolve(),get busy(){return busy;}};
};
module.exports.validateRepairSource=validateRepairSource;
module.exports.repairArgs=repairArgs;
module.exports.subtitleCues=subtitleCues;
module.exports.verifyChapters=verifyChapters;
module.exports.candidateWarnings=candidateWarnings;
