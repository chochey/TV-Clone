// Phase 3 of MEDIA_CONVERSION_PLAN.md — the background conversion queue.
//
// Replaces the phase-2 pilot's hardcoded ten-file list and, critically, its
// blocking execution: the pilot ran inside the HTTP request and held the
// connection ~100s for ten files, which would time out long before finishing
// the 981 that remain. Here start() returns immediately and the run proceeds
// in the background; the UI polls /status.
//
// The state machine is deliberately small — idle | running | paused | interrupted | stopping
// — because every extra state is another way for the UI and the worker to
// disagree about whether files are being modified right now.
//
// Resource limits are re-read from config before EVERY file, not captured at
// start(). A run over hundreds of files can last hours; an admin who lowers
// concurrency or turns on pause-while-playing at 2am should not have to stop
// and restart the queue for it to take effect.

const MINUTE = 60 * 1000;

// Pure: is `now` inside the [start,end] HH:MM window? Exported for testing
// because the wrap-past-midnight case (22:00–06:00) is exactly the kind of
// thing that looks obviously right and is off by one whole night.
function withinSchedule(schedule, now = new Date()) {
  const { start, end } = schedule || {};
  if (!start || !end) return true;                 // empty window = anytime
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return true;                        // zero-width = no restriction
  return s < e ? (mins >= s && mins < e)           // 02:00–08:00
    : (mins >= s || mins < e);                     // 22:00–06:00, wraps midnight
}

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const MAX_RESULTS = 200, MAX_RUNS = 20, MAX_FILES = 25000;
const validPath = file => typeof file === 'string' && file.length <= 4096 && !file.includes('\0') && path.isAbsolute(file);
const validFingerprint = value => value && ['dev','ino','size','mtimeMs','ctimeMs'].every(key => Number.isFinite(value[key]) && value[key] >= 0);
const sameFingerprint = (a,b) => validFingerprint(a) && validFingerprint(b)
  && ['dev','ino','size','mtimeMs','ctimeMs'].every(key => a[key] === b[key]);

async function fileFingerprint(file) {
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return {dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs};
  } catch { return null; }
}

module.exports = function createConversionQueue({
  worker, getConfig, getEligibleFiles, isPlaybackActive,
  getFileSize = () => 0, getRetainedBytes,
  getFingerprint = fileFingerprint, getMediaId = () => null,
  loadState = () => null,
  saveState = async () => {}, // Caller supplies strict, awaited atomic persistence.
  review,
  getRealPath = file => fs.promises.realpath(file),
  onFileComplete = () => {}, onBatchComplete,
  log = () => {}, now = () => new Date(),
  sleep,
}) {
  let status = 'idle', scope = 'batch', queue = [], cursor = 0, current = null;
  let runId = '', startedAt = 0, results = [], history = [], runs = [];
  let converted = 0, failed = 0, skipped = 0, bytesBefore = 0, bytesAfter = 0;
  let waitingReason = '', lastError = '', loopRunning = false, preparing = false;
  let deferred = new Map(), wake = () => {}, writeTail = Promise.resolve();
  let seedState=null,reviewInitialized=false,reviewExpected=false,reviewInitializing=null,reviewSuppressed=0;
  async function ensureReview() {
    if (!review) return;
    if (!reviewInitialized) {
      if (!reviewInitializing) reviewInitializing=(async()=>{
        await review.ready({expectExisting:seedState?.reviewInitialized===true});
        // Establish the fail-closed marker before creating the registry. If
        // initialization or the process fails afterward, a restart must not
        // mistake a lost review file for the first upgrade and reset holds.
        reviewExpected=true;
        if(seedState?.reviewInitialized!==true)await persist(undefined,true);
        await review.seed(seedState,getFingerprint);
        await review.ready({expectExisting:true});reviewInitialized=true;
      })().finally(()=>{reviewInitializing=null;});
      await reviewInitializing;
    }
    await review.ready({expectExisting:true});
  }
  async function wait(ms) {
    let timer;
    const delay=sleep ? sleep(ms) : new Promise(resolve => {timer=setTimeout(resolve,ms);});
    try {await Promise.race([delay,new Promise(resolve => {wake=resolve;})]);}
    finally {if(timer)clearTimeout(timer);}
  }

  function runSummary(outcome) {
    return {id:runId,scope,status:outcome,startedAt,finishedAt:Date.now(),total:queue.length,
      done:cursor,converted,failed,skipped,bytesBefore,bytesAfter,reason:lastError};
  }
  function archiveRun(outcome) {
    if (!runId) return;
    runs = [runSummary(outcome),...runs.filter(run => run.id !== runId)].slice(0,MAX_RUNS);
  }
  function durableState(overrides = {}) {
    return {version:1,reviewInitialized:!!review&&reviewExpected,
      run:{id:runId,status,scope,queue,cursor,startedAt,converted,failed,skipped,
      bytesBefore,bytesAfter,lastError,results,reviewSuppressed,...overrides},history,runs};
  }
  async function persist(overrides,reviewMarker=reviewExpected) {
    // Capture before queuing: a later pause/stop must not change an earlier write.
    const data = JSON.parse(JSON.stringify({...durableState(overrides),reviewInitialized:!!review&&reviewMarker}));
    const next = writeTail.catch(() => {}).then(() => saveState(data));
    writeTail = next;
    await next;
  }
  function persistenceFailure(error) {
    lastError = `Could not save conversion progress: ${error.message}; resume after fixing storage`;
    log(lastError);
    if (status !== 'idle' && status !== 'stopping') {
      status = 'interrupted'; worker.setPaused?.(true); wake();
    }
  }

  // Recovery reads only metadata. It never invokes a worker or resumes a job.
  try {
    const saved = loadState();
    seedState=saved;
    reviewExpected=saved?.reviewInitialized===true;
    if (saved) {
      if (saved.version !== 1 || !saved.run || !Array.isArray(saved.run.queue)
          || saved.run.queue.length > MAX_FILES || !Number.isInteger(saved.run.cursor)
          || saved.run.cursor < 0 || saved.run.cursor > saved.run.queue.length
          || !['idle','running','paused','interrupted','stopping'].includes(saved.run.status)
          || !saved.run.queue.every(entry => entry && validPath(entry.filePath))
          || new Set(saved.run.queue.map(entry => entry.filePath)).size !== saved.run.queue.length) {
        throw Error('saved queue is invalid');
      }
      const run = saved.run;
      runId = typeof run.id === 'string' ? run.id : '';
      scope = ['all','retry'].includes(run.scope) ? run.scope : 'batch';
      queue = run.queue.map(entry => ({filePath:entry.filePath,
        fingerprint:validFingerprint(entry.fingerprint) ? entry.fingerprint : null,
        mediaId:typeof entry.mediaId === 'string' ? entry.mediaId : null,
        ...(typeof entry.priorReviewId==='string' && /^[a-f0-9]{32}$/.test(entry.priorReviewId) ? {priorReviewId:entry.priorReviewId} : {}),
        ...(typeof entry.retryReviewId==='string' && /^[a-f0-9]{32}$/.test(entry.retryReviewId) ? {retryReviewId:entry.retryReviewId} : {})}));
      cursor = run.cursor;
      startedAt = Number(run.startedAt) || 0;
      for (const key of ['converted','failed','skipped','bytesBefore','bytesAfter']) {
        const value = run[key];
        if (!Number.isFinite(value) || value < 0) {
          if (key === 'skipped' && value === undefined) continue;
          throw Error('saved counters are invalid');
        }
      }
      ({converted,failed,skipped = 0,bytesBefore,bytesAfter} = run);
      reviewSuppressed=Number.isInteger(run.reviewSuppressed)&&run.reviewSuppressed>=0?run.reviewSuppressed:0;
      lastError = typeof run.lastError === 'string' ? run.lastError : '';
      const safeResult = value => value && typeof value.name === 'string' && Number.isFinite(value.at);
      results = (Array.isArray(run.results) ? run.results : []).filter(safeResult).slice(0,MAX_RESULTS);
      history = (Array.isArray(saved.history) ? saved.history : []).filter(safeResult).slice(0,MAX_RESULTS);
      runs = (Array.isArray(saved.runs) ? saved.runs : []).filter(value => value && typeof value.id === 'string').slice(0,MAX_RUNS);
      status = ['running','paused','interrupted'].includes(run.status) ? 'interrupted' : 'idle';
      if (run.status === 'stopping') archiveRun('stopped');
    }
  } catch {
    status = 'idle'; queue = []; cursor = 0; runId = '';
    results = []; history = []; runs = []; converted = failed = skipped = bytesBefore = bytesAfter = 0;
    lastError = 'Saved conversion progress could not be read; start a new run after reviewing the library';
  }
  // Upgrade only imports proven failures from the saved run. It never runs a
  // worker. Keeping this promise outside the server makes API reads wait for
  // the same serialized registry bootstrap without changing startup behavior.
  if(review) void ensureReview().catch(error=>{lastError=error.message;log(lastError);});

  function snapshot() {
    return {status,scope,runId,progress:worker.progress?.() || null,total:queue.length,done:cursor,
      remaining:Math.max(0,queue.length-cursor),current:current ? path.basename(current) : null,
      currentPath:current,waitingReason,lastError,converted,failed,skipped,bytesBefore,bytesAfter,startedAt,
      results:results.slice(0,40),history:history.slice(0,60),runs:runs.slice(),
      deferredCount:deferred.size,deferred:[...deferred.entries()].slice(0,20)
        .map(([filePath,value]) => ({id:filePath,name:path.basename(filePath),...value})),
      reviewSuppressed,canResume:status === 'interrupted' || status === 'paused'};
  }

  async function blockedReason() {
    const cfg = getConfig();
    if (cfg.enabled === false) return 'conversion is disabled';
    if (cfg.pauseWhilePlaying && isPlaybackActive()) return 'someone is watching';
    if (!withinSchedule(cfg.schedule,now())) return `outside the ${cfg.schedule.start}–${cfg.schedule.end} window`;
    if (cfg.retainOriginals === false) return '';
    let retainedBytes;
    try { retainedBytes = await getRetainedBytes(); }
    catch { return 'cannot read retained originals; waiting for storage'; }
    if (retainedBytes + (queue[cursor] ? getFileSize(queue[cursor].filePath) : 0) >= cfg.retainedBudgetGB * 1e9) {
      return `retention budget reached (${cfg.retainedBudgetGB} GB of originals held)`;
    }
    return '';
  }

  async function record(entry,result) {
    const at=Date.now();
    if(review) {
      if(result.ok)await review.complete(entry,{priorReviewId:entry.priorReviewId});
      else if(!result.skipped && !result.deferred)await review.record(entry,result,{at});
    }
    deferred.delete(entry.filePath);
    if (result.ok) { converted++; bytesBefore += result.bytesBefore || 0; bytesAfter += result.bytesAfter || 0; }
    else if (result.skipped) skipped++;
    else failed++;
    const outcome = {name:path.basename(entry.filePath),mediaId:entry.mediaId || null,filePath:entry.filePath,newPath:result.newPath || null,
      runId,ok:!!result.ok,outcome:result.ok ? 'converted' : result.skipped ? 'skipped' : 'review',
      reason:result.cleanupWarning || result.reason || '',at,
      bytesBefore:result.bytesBefore || 0,bytesAfter:result.bytesAfter || 0,
      originalDeleted:result.originalDeleted === true,retainedPath:result.retainedPath || null};
    results.unshift(outcome); results.length = Math.min(results.length,MAX_RESULTS);
    history.unshift(outcome); history.length = Math.min(history.length,MAX_RESULTS);
  }

  async function revalidateRemaining() {
    const allowed = new Set(await getEligibleFiles(getConfig()));
    const retained = [];
    for (const entry of queue.slice(cursor)) {
      if (!allowed.has(entry.filePath)) {
        await record(entry,{ok:false,skipped:true,reason:'No longer eligible; skipped without changing the file'});
      } else if (!sameFingerprint(entry.fingerprint,await getFingerprint(entry.filePath))) {
        await record(entry,{ok:false,reason:'Needs review: source changed or is unavailable since this run was saved; not touched'});
      } else if(review?.isBlocked(entry) && !review.allowsRetry(entry,entry.retryReviewId)) {
        await record(entry,{ok:false,skipped:true,reason:'Already needs review; unchanged source skipped without touching it'});
      } else retained.push(entry);
    }
    // Keep finished entries so totals and the original batch scope remain honest.
    const removed = queue.length-cursor-retained.length;
    const completed = queue.slice(0,cursor);
    const discarded = queue.slice(cursor).filter(entry => !retained.includes(entry));
    queue = [...completed,...discarded,...retained]; cursor += removed;
    deferred = new Map();
  }

  async function loop() {
    if (loopRunning || preparing) return;
    loopRunning = true;
    try {
      while (status === 'running' && cursor < queue.length) {
        const reason = await blockedReason();
        if (status !== 'running') break;
        if (reason) {
          if (waitingReason !== reason) log(`waiting — ${reason}`);
          waitingReason = reason; await wait(MINUTE); continue;
        }
        if (queue.slice(cursor).every(entry => deferred.has(entry.filePath))) {
          waitingReason = `${deferred.size} file(s) waiting: ${[...new Set([...deferred.values()].map(value => value.reason))].join('; ')}`;
          await wait(MINUTE);
          if (status !== 'running') break;
          deferred.clear();
        }
        waitingReason = '';
        const entry = queue[cursor], filePath = entry.filePath;
        if (!sameFingerprint(entry.fingerprint,await getFingerprint(filePath))) {
          if (status !== 'running') break;
          await record(entry,{ok:false,reason:'Needs review: source changed or is unavailable since it was queued; not touched'});
          cursor++; await persist(); continue;
        }
        await ensureReview();
        if(review?.isBlocked(entry) && !review.allowsRetry(entry,entry.retryReviewId)) {
          await record(entry,{ok:false,skipped:true,reason:'Already needs review; unchanged source skipped without touching it'});
          cursor++;await persist();continue;
        }
        if (status !== 'running') break;
        // The last completed cursor is durable before any next source is touched.
        current = filePath; await persist();
        if (status !== 'running') { current = null; break; }
        const monitor = setInterval(() => {
          const cfg = getConfig();
          const autoReason = cfg.enabled === false ? 'conversion is disabled'
            : cfg.pauseWhilePlaying && isPlaybackActive() ? 'someone is watching'
            : !withinSchedule(cfg.schedule,now()) ? 'outside the scheduled window' : '';
          waitingReason = autoReason;
          worker.setPaused?.(status === 'paused' || !!autoReason);
        },1000);
        let result;
        try {
          worker.setPaused?.(false);
          result = await (worker.convertCompatible || worker.convertContainerOnly)(filePath);
        } finally { clearInterval(monitor); }
        current = null;
        if (status === 'stopping') break; // Explicit Stop never becomes a failed conversion.
        if (result.deferred === true && ['playback','storage'].includes(result.code)) {
          deferred.set(filePath,{code:result.code,reason:result.reason,storage:result.storage || null});
          queue.splice(cursor,1); queue.push(entry); // Other files/drives can still make progress.
          await persist(); continue;
        }
        await record(entry,result);cursor++;
        if (result.ok) {
          try { onFileComplete(result); } catch (error) { log(`Library refresh failed: ${error.message}`); }
        }
        log(`${result.ok ? 'OK' : 'SKIP'} ${path.basename(filePath)}${result.ok ? '' : ` — ${result.reason}`}`);
        if (result.cleanupWarning) {lastError=result.cleanupWarning;log(lastError);status='stopping';}
        await persist();
      }
    } catch (error) {
      persistenceFailure(error);
    } finally {
      current = null;
      const finished = cursor >= queue.length && status === 'running';
      if (finished || status === 'stopping') {
        if (converted > 0) { try { onBatchComplete?.(); } catch {} }
        archiveRun(finished ? 'complete' : 'stopped');
        log(`run ${finished ? 'complete' : 'stopped'}: ${converted} converted, ${failed} skipped`);
        status='stopping';waitingReason='Saving conversion history';deferred.clear();
        try {await persist({status:'idle'});status='idle';waitingReason='';}
        catch(error) {
          lastError=`Could not save conversion progress: ${error.message}`;log(lastError);
          status=finished ? 'interrupted' : 'idle';waitingReason='';
        }
      }
      loopRunning = false;
      if (status === 'running' && cursor < queue.length) queueMicrotask(loop);
    }
  }

  async function start({all=false}={}) {
    if (status === 'stopping' || preparing || (status === 'idle' && loopRunning)) return {ok:false,error:'Wait for the current job to stop or finish preparing'};
    if (status === 'running') return {ok:false,error:'Already running'};
    if (status === 'interrupted') return {ok:false,error:'Resume the interrupted run or stop it before starting a new run'};
    if (status === 'paused') {
      if (all === true) return {ok:false,error:'Resume the paused run or stop it before starting Convert all'};
      return resume();
    }
    const cfg=getConfig();
    if (cfg.enabled === false) return {ok:false,error:'Enable conversion before starting'};
    preparing=true;
    let eligible;
    try {
      await ensureReview();
      eligible=[...new Set(await getEligibleFiles(cfg))].filter(validPath);
      if (!eligible.length) return {ok:false,error:'Nothing eligible to convert'};
      if (eligible.length > MAX_FILES) return {ok:false,error:'Too many conversion candidates; select fewer libraries'};
      scope=all===true ? 'all' : 'batch';
      queue=eligible.map(filePath => ({filePath,fingerprint:null,mediaId:getMediaId(filePath),
        ...(review ? {priorReviewId:review.priorIdForPath(filePath)} : {})}));
      runId=randomUUID();startedAt=Date.now();cursor=0;results=[];
      converted=failed=skipped=bytesBefore=bytesAfter=0;reviewSuppressed=0;lastError='';waitingReason='';deferred.clear();
      status='running';
      // Bounded metadata IO; never read video contents to capture job identity.
      for (let index=0;index<queue.length;index+=16) {
        await Promise.all(queue.slice(index,index+16).map(async entry => {entry.fingerprint=await getFingerprint(entry.filePath);}));
        if (status === 'idle' || status === 'stopping') return {ok:false,error:'Run stopped before conversion began'};
      }
      const unblocked=queue.filter(entry=>!review?.isBlocked(entry));
      reviewSuppressed=queue.length-unblocked.length;
      queue=scope==='all'?unblocked:unblocked.slice(0,cfg.maxFilesPerRun);
      if(!queue.length) {
        status='idle';await persist();
        return {ok:false,error:'All eligible files already need review. Replace a source or explicitly retry one reviewed file.',suppressed:reviewSuppressed};
      }
      await persist();
      if (status === 'idle' || status === 'stopping') return {ok:false,error:'Run stopped before conversion began'};
      log(`starting ${scope} — ${queue.length} file(s) queued`);
    } catch(error) {
      persistenceFailure(error);return {ok:false,error:lastError};
    } finally {preparing=false;}
    if (status === 'running') loop();
    return {ok:true,queued:queue.length,eligible:eligible.length,suppressed:reviewSuppressed};
  }

  async function pause() {
    if (status !== 'running') return {ok:false,error:`Cannot pause while ${status}`};
    status='paused';worker.setPaused?.(true);wake();
    try {await persist();} catch(error) {persistenceFailure(error);return {ok:false,error:lastError};}
    log('paused — current conversion is suspended');return {ok:true};
  }
  async function resume() {
    if (!['paused','interrupted'].includes(status)) return {ok:false,error:`Cannot resume while ${status}`};
    if (preparing) return {ok:false,error:'Queue is preparing; try again shortly'};
    if (getConfig().enabled === false) return {ok:false,error:'Enable conversion before resuming'};
    const previous=status;
    preparing=true;
    try {
      await ensureReview();
      // A paused live worker keeps its current source; recovered jobs have no worker.
      if (!current) await revalidateRemaining();
      if (status !== previous) return {ok:false,error:'Run changed while preparing to resume'};
      await persist({status:'running',lastError:''});
      if (status !== previous) return {ok:false,error:'Run changed while preparing to resume'};
      status='running';lastError='';waitingReason='';worker.setPaused?.(false);wake();
    } catch(error) {persistenceFailure(error);return {ok:false,error:lastError};}
    finally {preparing=false;}
    log('resumed after checking queued sources');loop();return {ok:true};
  }
  async function retryReview(id) {
    if(!review)return {ok:false,error:'Conversion review records are unavailable'};
    if(status!=='idle'||preparing||loopRunning)return {ok:false,error:'Stop the current run before retrying a reviewed file'};
    if(getConfig().enabled===false)return {ok:false,error:'Enable conversion before retrying'};
    if(typeof id!=='string'||!(/^[a-f0-9]{32}$/).test(id))return {ok:false,error:'Invalid review entry'};
    preparing=true;
    try {
      await ensureReview();
      const row=await review.get(id);
      if(!row)return {ok:false,error:'Review entry not found'};
      const allowed=new Set(await getEligibleFiles(getConfig()));
      if(!allowed.has(row.filePath))return {ok:false,error:'This source is no longer eligible in the selected libraries and categories'};
      if(await getRealPath(row.filePath)!==row.filePath)return {ok:false,error:'The reviewed source path changed or contains a symbolic link; rescan before retrying'};
      const fingerprint=await getFingerprint(row.filePath);
      if(!sameFingerprint(row.fingerprint,fingerprint))return {ok:false,error:'The reviewed source changed or is missing. Start a new run to check its replacement.'};
      if(!review.allowsRetry({filePath:row.filePath,fingerprint},id))return {ok:false,error:'The review entry changed; refresh the review list'};
      // The authorization belongs to this single, durable queue entry. The
      // registry hold remains in place through cancellation or another failure.
      scope='retry';queue=[{filePath:row.filePath,fingerprint,mediaId:getMediaId(row.filePath),retryReviewId:id}];
      runId=randomUUID();startedAt=Date.now();cursor=0;results=[];
      converted=failed=skipped=bytesBefore=bytesAfter=0;reviewSuppressed=0;lastError='';waitingReason='';deferred.clear();status='running';
      await persist();
      if(status!=='running')return {ok:false,error:'Retry was stopped before conversion began'};
    } catch(error) {
      if(status!=='idle')persistenceFailure(error);
      return {ok:false,error:error.code==='ENOENT'?'The reviewed source is missing':error.message};
    } finally {preparing=false;}
    loop();return {ok:true,queued:1,eligible:1,suppressed:0};
  }
  async function stop() {
    if (status === 'idle') return {ok:false,error:'Not running'};
    status='stopping';const killed=worker.killActive();wake();
    try {
      // Persist the user's stop intent even when the active worker needs time to exit.
      await persist();
      if (!loopRunning) {archiveRun('stopped');status='idle';waitingReason='';deferred.clear();await persist();}
    } catch(error) {lastError=`Could not save stop state: ${error.message}`;log(lastError);return {ok:false,error:lastError};}
    log(`stopping${killed ? ' — killed the in-flight conversion' : ''}`);
    return {ok:true,killedInFlight:killed};
  }
  return {start,pause,resume,stop,retryReview,snapshot,flush:()=>writeTail,
    configurationChanged:()=>wake(),get status(){return status;}};
};
module.exports.withinSchedule=withinSchedule;
module.exports.fileFingerprint=fileFingerprint;
