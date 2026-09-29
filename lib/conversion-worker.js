// Phase 2 of MEDIA_CONVERSION_PLAN.md — Tier 1 (container remux) execution.
//
// This module is REQUIRED FROM server.js, not run as a standalone script.
// That is load-bearing, not a style choice: lib/profile-data.js caches each
// profile's JSON in memory for the life of the process and only reads from
// disk on first touch (see loadProfileData). A separate script editing
// data/profile_*.json directly would race the live server's in-memory copy —
// whichever side writes last wins, and the server's next unrelated
// saveProfileData() call (e.g. a progress ping for a totally different item)
// would silently overwrite the external edit with its stale cached copy.
// Requiring this module into the live process means it shares the exact
// same loadProfileData/saveProfileData/probe-cache instances the server
// already uses, so there is nothing to race.
//
// Also load-bearing: the media folders live on fuse.mergerfs, where
// `fs.watch` is documented (server.js, near setupOrganizerWatch) as blind —
// the existing file-watcher does NOT see renames made here. Nothing except
// a manual /api/scan or the hourly safety rescan would otherwise notice a
// converted file exists. The caller is expected to invalidate the library
// once after a batch, the same way /api/scan and the organizer watcher do.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const {createPacketCollector,validateSourcePackets,verifyPacketPreservation,verifyDecodedSample,verifyDecodeDiagnostics}=require('./conversion-verification');

// Run only after verification, replacement, profile migration and cache updates
// have succeeded. This must NEVER throw into conversion's rollback after the
// original is deleted: that rollback would remove the remaining good output.
function finalizeOriginal(retainedPath, retainOriginals, io = fs) {
  if (retainOriginals !== false) return { retainedPath, originalDeleted: false };
  try { io.unlinkSync(retainedPath); }
  catch (err) {
    return { retainedPath, originalDeleted: false, cleanupWarning: `Converted successfully; could not delete the old file: ${err.message}` };
  }
  try { io.unlinkSync(retainedPath + '.conversion.json'); } catch {}
  try {
    const dir = path.dirname(retainedPath);
    if (io.readdirSync(dir).length === 0) io.rmdirSync(dir);
  } catch {}
  return { retainedPath: null, originalDeleted: true };
}

// ── Pure helpers (exported for testing without touching real data) ───────

// Every id-keyed structure lib/profile-data.js's DEFAULTS can hold, in one
// place — so a new structure added there later is a one-line addition here,
// not a silent migration gap. Returns a NEW object; never mutates its input,
// so a caller can inspect before/after or bail out without side effects.
function migrateProfileIds(data, oldId, newId) {
  if (!data || oldId === newId) return { data, touched: false };
  let touched = false;
  const out = { ...data };

  const moveKey = (obj) => {
    if (!obj || !Object.hasOwn(obj, oldId)) return obj;
    const copy = { ...obj };
    copy[newId] = copy[oldId];
    delete copy[oldId];
    touched = true;
    return copy;
  };

  out.progress = moveKey(out.progress);
  out.watched = moveKey(out.watched);
  out.subtitleOffsets = moveKey(out.subtitleOffsets);

  if (Array.isArray(out.history) && out.history.some((h) => h?.id === oldId)) {
    out.history = out.history.map((h) => (h?.id === oldId ? { ...h, id: newId } : h));
    touched = true;
  }
  // queue/watchlist are plain arrays of id strings (see server.js's
  // data.queue.includes(id)/.push(id) call sites), not objects.
  if (Array.isArray(out.queue) && out.queue.includes(oldId)) {
    out.queue = out.queue.map((q) => (q === oldId ? newId : q));
    touched = true;
  }
  if (Array.isArray(out.watchlist) && out.watchlist.includes(oldId)) {
    out.watchlist = out.watchlist.map((w) => (w === oldId ? newId : w));
    touched = true;
  }

  if (out.dismissed) {
    const cw = moveKeyLocal(out.dismissed.continueWatching);
    const ra = moveKeyLocal(out.dismissed.recentlyAdded);
    if (cw.touched || ra.touched) {
      out.dismissed = { ...out.dismissed, continueWatching: cw.obj, recentlyAdded: ra.obj };
      touched = true;
    }
  }
  function moveKeyLocal(obj) {
    if (!obj || !Object.hasOwn(obj, oldId)) return { obj, touched: false };
    const copy = { ...obj };
    copy[newId] = copy[oldId];
    delete copy[oldId];
    return { obj: copy, touched: true };
  }

  return { data: out, touched };
}

// Where a converted file's original lives during the retention window. A
// dotdir sibling: the scanner's folder walk explicitly skips any entry whose
// name starts with '.' (server.js, walkFolder), so this is invisible to the
// library without any special-casing on the scan side.
function retainedPathFor(filePath) {
  return path.join(path.dirname(filePath), '.converted-originals', path.basename(filePath));
}

// Same directory, new extension, same stem — so sidecar subtitle discovery
// (fs-helpers.findSubtitles matches on the filename stem, not the container
// extension) keeps working across the conversion without any special-casing.
function newPathFor(filePath) {
  const { dir, name } = path.parse(filePath);
  return path.join(dir, `${name}.mp4`);
}

function tempPathFor(filePath) {
  const { dir, name } = path.parse(filePath);
  return path.join(dir, `.${name}.converting.${process.pid}.mp4`);
}

// ── IO helpers ─────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
    // Let a caller kill a long remux mid-flight (the queue's stop button).
    if (opts.onSpawn) opts.onSpawn(child);
  });
}

function runStreaming(cmd, args, { onSpawn, onStdout, onStderr }) {
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});
    let stderr='', failure=null;
    child.stdout.on('data',chunk=>{
      try {onStdout?.(chunk);} catch(error) {failure=error;child.kill('SIGTERM');}
    });
    child.stderr.on('data',chunk=>{
      if(stderr.length<4096)stderr+=String(chunk).slice(0,4096-stderr.length);
      try {onStderr?.(chunk);} catch(error) {failure=error;child.kill('SIGTERM');}
    });
    child.on('error',reject);
    child.on('close',(code,signal)=>{
      if(failure)reject(failure);
      else if(code!==0) {const error=new Error(`${cmd} exited ${code ?? signal}: ${stderr.split('\n').find(Boolean)||'no diagnostic output'}`);error.stderr=stderr;reject(error);}
      else resolve('');
    });
    onSpawn?.(child);
  });
}

// Wraps an ffmpeg invocation in nice/ionice so conversion genuinely yields to
// playback rather than merely claiming to. Pure so the composition is
// unit-testable without spawning anything: returns [cmd, args].
//
// ionice -c 3 (idle) matters more than nice here — these jobs are almost pure
// IO, and the box's contention is disk, not CPU. nice alone would not stop a
// batch from starving a stream's reads.
function withResourceLimits(ffmpegArgs, limits = {}) {
  const { niceness, ffmpegThreads } = limits;
  const args = [...ffmpegArgs];
  // -threads is an ffmpeg option and must precede the output; inserting right
  // after the leading -v error keeps it a global option.
  if (ffmpegThreads > 0) args.splice(2, 0, '-threads', String(ffmpegThreads));
  if (!(niceness > 0)) return ['ffmpeg', args];
  return ['nice', ['-n', String(niceness), 'ionice', '-c', '3', 'ffmpeg', ...args]];
}

// Longest duration among the streams we actually carry across (video and
// audio). Pure, so the parsing is unit-testable.
//
// Comparing container duration to container duration is WRONG here and was
// rejecting valid files: MKV reports the container as its longest stream,
// including subtitles, and a subtitle track routinely runs past the end of
// the picture. Measured on Mr Inbetween S02E02 — video 1558.954s, audio
// 1558.997s, subtitle 1611.152s, so the container claimed 1611s. The remux
// drops subtitles by design, so its output was a correct 1559s, and the
// naive check called that 52 seconds of lost content.
//
// MKV also puts per-stream length in a DURATION tag rather than the numeric
// `duration` field, so both forms have to be understood.
function mediaDurationOf(probe) {
  let best = 0;
  for (const s of probe?.streams || []) {
    if (s.codec_type !== 'video' && s.codec_type !== 'audio') continue;
    let d = parseFloat(s.duration);
    if (!Number.isFinite(d) || d <= 0) {
      const tag = s.tags?.DURATION || s.tags?.duration;
      if (tag) {
        const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(tag).trim());
        if (m) d = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      }
    }
    if (Number.isFinite(d) && d > best) best = d;
  }
  // Nothing per-stream (some containers report neither) — fall back to the
  // container, which is at least a real number even if it can overstate.
  if (!best) best = parseFloat(probe?.format?.duration) || 0;
  return best;
}

async function ffprobeJson(filePath) {
  const out = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ]);
  return JSON.parse(out);
}

// Pure — extracted from convertContainerOnly so the exact args are assertable
// by a fast unit test without spawning ffmpeg. See conversion-worker.test.js:
// "-map_chapters -1 regression" for why this exists as its own function.
function buildRemuxArgs(filePath, tempPath) {
  return [
    '-v', 'error', '-y', '-i', filePath,
    '-map', '0:v', '-map', '0:a', '-c', 'copy', '-sn',
    // Without this, ffmpeg carries MKV chapter markers into the MP4 as an
    // orphaned "bin_data"/text stream tagged SubtitleHandler — confirmed on a
    // real pilot file (Rick and Morty S06E03, 5 chapters) via stream_tags:
    // handler_name "SubtitleHandler", codec_tag "text", codec_type "data".
    // Harmless to playback but not a stream that should exist. This app has
    // no chapter-navigation UI, so nothing is lost by dropping them, only a
    // malformed stream avoided.
    '-map_chapters', '-1',
    '-movflags', '+faststart', tempPath,
  ];
}

// Decodes without writing anything, to catch a container that LOOKS fine
// (parses, right duration) but is actually corrupt inside — e.g. a copy
// that got truncated mid-write.
//
// Exit code is the authoritative signal, not stderr content. Confirmed on a
// pilot run against real library files: the null muxer emits "Application
// provided invalid, non monotonically increasing dts to muxer" as an
// -v error-level line for some legitimate encodes (observed on 4 of 10 real
// files, reproducible 3/3 tries, identical byte offsets each time) while
// still exiting 0 and decoding every frame correctly — verified by rerunning
// the exact command against one of those files' known-good post-remux copy.
// A file that is GENUINELY truncated fails differently and loudly: the
// demuxer itself errors ("File ended prematurely") and ffmpeg exits non-zero
// well before reaching this check at all — that case is still caught, by the
// remux step's own exit-code check.
function verifyDecodes(filePath, seekTime, duration) {
  const args = ['-v', 'error', '-hide_banner'];
  if (seekTime > 0) args.push('-ss', String(seekTime));
  args.push('-i', filePath, '-t', String(duration), '-f', 'null', '-');
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`decode check failed: ${stderr.split('\n')[0] || err.message}`));
      else resolve();
    });
  });
}

module.exports = function createConversionWorker({
  hashId,                 // (filePath) => id — MUST be the exact function server.js uses
  probeCache, pixFmtCache, audioProbeCache, audioTracksCache, subProbeCache, heightCache, levelCache,
  markDirty, scheduleSaveMediaInfo,
  getActiveTranscodeFilePaths,  // () => Set<filePath> currently being transcoded — never touch these
  loadProfileData, saveProfileData, saveProfileDataStrict, profileIds,  // () => string[]
  TEXT_SUB_CODECS,
  minFreeSpaceBytes = 2,   // multiplier of source size required free on the branch
  // () => { niceness, ffmpegThreads } — read per-file, not captured once, so a
  // limit changed mid-run takes effect on the next file rather than requiring
  // a restart.
  getLimits = () => ({}),
  log = () => {},
}) {
  // Tracks the ffmpeg child of the file being converted right now, so a stop
  // can kill it instead of waiting out a multi-minute remux. Only ever one:
  // concurrency above 1 is not supported by this worker.
  let activeChild = null;
  function killActive() {
    cancelled = true;
    paused = false;
    if (!activeChild) return false;
    try { activeChild.kill('SIGCONT'); } catch {}
    try { activeChild.kill('SIGTERM'); } catch {}
    activeChild = null;
    return true;
  }

  // Every ffmpeg invocation in this module goes through here so none can
  // accidentally escape the nice/ionice wrapper or the kill tracking.
  async function runFfmpeg(args) {
    const [cmd, finalArgs] = withResourceLimits(args, getLimits());
    try {
      return await run(cmd, finalArgs, { onSpawn: (c) => { activeChild = c; } });
    } finally {
      activeChild = null;
    }
  }

  const storage = require('./conversion-storage')();

  // Returns { ok, reason } rather than throwing — every reason is something
  // the caller should show to a human, not an exception to unwind.
  async function preflight(filePath) {
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'source file does not exist' };
    if (getActiveTranscodeFilePaths().has(filePath)) {
      return { ok: false, reason: 'currently being streamed — skipped, not touched' };
    }
    const st = fs.statSync(filePath);
    const drive = await storage.freeSpace(filePath);
    if (!drive.known) return {ok:false,reason:'Needs review: cannot confirm free space on the physical drive; original retained'};
    const avail = drive.available;
    const minimum = Math.max(st.size * minFreeSpaceBytes, (getLimits().minFreeSpaceGB || 0) * 1e9 + st.size * 2);
    if (avail < minimum) {
      return { ok: false, reason: `insufficient free space on ${drive.label || drive.mount} (need ~${Math.round(minimum / 1e9)} GB, have ${Math.round(avail / 1e9)} GB)` };
    }
    return { ok: true, size: st.size };
  }

  // Extracts every embedded TEXT subtitle stream to a sidecar .srt. Any
  // single track failing aborts the whole extraction — a partial extraction
  // (some languages present, some silently gone) is worse than none, because
  // it looks complete. Returns the list of files it wrote, so the caller can
  // clean them up if a later step fails.
  async function extractTextSubs(filePath, subs) {
    const written = [];
    const textSubs = (subs || []).filter((s) => TEXT_SUB_CODECS.has(s.codec));
    for (const s of textSubs) {
      const tag = s.lang || `track${s.index}`;
      const { dir, name } = path.parse(filePath);
      let out = path.join(dir, `${name}.${tag}.srt`);
      if (fs.existsSync(out)) out = path.join(dir, `${name}.${tag}.${s.index}.srt`);
      try {
        await runFfmpeg(['-v', 'error', '-y', '-i', filePath, '-map', `0:${s.index}`, '-c:s', 'srt', out]);
        written.push(out);
      } catch (err) {
        for (const w of written) { try { fs.unlinkSync(w); } catch {} }
        throw new Error(`subtitle extraction failed for stream ${s.index} (${tag}): ${err.stderr?.split('\n')[0] || err.message}`);
      }
    }
    return written;
  }

  // Converts one file. Never throws for expected failure modes — returns
  // { ok:false, reason } so a batch can keep going past one bad file.
  // Historical entry point: share the complete verification/commit workflow.
  // Keeping a second remux-only swap path would bypass strict persistence.
  async function convertContainerOnly(filePath) {
    return convertCompatible(filePath);
  }

  let cancelled = false, paused = false, progress = null;
  function setPaused(value) {
    paused = !!value;
    if (activeChild) { try { activeChild.kill(paused ? 'SIGSTOP' : 'SIGCONT'); } catch {} }
  }
  function checkCancelled() { if (cancelled) throw new Error('Stopped by user; original retained'); }
  async function controlledRun(command, args, streamOptions = null) {
    checkCancelled();
    const { cpuList } = require('./conversion-encode');
    let affinity = cpuList(getLimits().cpuCores);
    let monitor;
    try {
      const runner=streamOptions?runStreaming:run;
      const output = await runner('taskset', ['-c', affinity, 'nice', '-n', String(getLimits().niceness ?? 19),
        'ionice', '-c', '3', command, ...args], { ...streamOptions, onSpawn: child => {
          activeChild = child;
          if (paused) child.kill('SIGSTOP');
          child.stdout?.on('data', data => {
            const text = String(data);
            const seconds = text.match(/out_time_us=(\d+)/)?.[1];
            const speed = text.match(/speed=([^\s]+)/)?.[1];
            if (progress && seconds) progress.seconds = Number(seconds) / 1e6;
            if (progress && speed) progress.speed = speed;
          });
          monitor = setInterval(() => {
            if (!activeChild || activeChild !== child) return;
            const next = cpuList(getLimits().cpuCores);
            if (next !== affinity) {
              // -a applies the allocation to every encoder/decoder thread.
              execFile('taskset', ['-apc', next, String(child.pid)], err => {
                if (!err) affinity = next;
              });
            }
          }, 1000);
        } });
      checkCancelled();
      return output;
    } finally { clearInterval(monitor); activeChild = null; }
  }
  async function probeControlled(file) {
    return JSON.parse(await controlledRun('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file]));
  }
  async function packetsControlled(file,probe) {
    const collector=createPacketCollector(probe);
    await controlledRun('ffprobe',['-v','warning','-show_packets','-show_entries',
      'packet=stream_index,pts_time,dts_time,duration_time','-of','compact=p=0:nk=0',file],
    {onStdout:chunk=>collector.write(chunk),onStderr:chunk=>collector.warn(chunk)});
    return collector.finish();
  }
  async function convertCompatible(filePath) {
    cancelled = false;
    const settings = getLimits();
    const newPath = newPathFor(filePath), tempPath = tempPathFor(filePath), retainedPath = retainedPathFor(filePath);
    const written = [];
    let originalMoved = false, outputPlaced = false;
    const savedProfiles = [];
    const savedCaches = [];
    const oldId = hashId(filePath), newId = hashId(newPath);
    progress = { stage:'Checking source',seconds:0,duration:0,speed:'' };
    try {
      const pre = await preflight(filePath);
      if (!pre.ok) throw new Error(pre.reason);
      if (newPath !== filePath && fs.existsSync(newPath)) throw new Error('MP4 destination already exists; review the duplicate first');
      if (fs.existsSync(retainedPath)) throw new Error('An original is already retained for this file; restore or clean it up first');
      const originalStat = fs.statSync(filePath);
      const source = await probeControlled(filePath);
      const { inspectSource, buildCompatibleArgs, compatibleStreamPlan } = require('./conversion-encode');
      inspectSource(source); // rejects HDR, image subtitles, and unusual multi-video inputs
      progress.stage = 'Checking source packets';
      const sourcePackets=await packetsControlled(filePath,source);
      const duration = validateSourcePackets(source,sourcePackets);
      progress.duration = duration;
      for (const track of source.streams.filter(s=>s.codec_type==='subtitle')) {
        progress.stage = 'Extracting subtitles';
        const stem = path.join(path.dirname(filePath),path.parse(filePath).name);
        const lang = String(track.tags?.language || 'und').replace(/[^a-z0-9-]/gi,'');
        let suffix = 0, out;
        do { out = `${stem}.${lang}.track${track.index}${suffix ? '.'+suffix : ''}.srt`; suffix++; } while(fs.existsSync(out));
        written.push(out);
        await controlledRun('ffmpeg',['-v','error','-nostdin','-n','-i',filePath,'-map',`0:${track.index}`,'-c:s','srt',out]);
      }
      progress.stage = 'Converting';
      let conversionErrors='';
      await controlledRun('ffmpeg',buildCompatibleArgs(filePath,tempPath,source,settings),{
        onStderr:chunk=>{if(conversionErrors.length<4096)conversionErrors+=String(chunk).slice(0,4096-conversionErrors.length);},
      });
      if(conversionErrors.trim())throw new Error(`Needs review: conversion reported media errors (${conversionErrors.split('\n').find(Boolean)}); original retained`);
      progress.stage = 'Verifying';
      const output = await probeControlled(tempPath);
      const outputPackets=await packetsControlled(tempPath,output);
      const tracks=verifyPacketPreservation(sourcePackets,outputPackets,compatibleStreamPlan(source),output);
      const video = output.streams.find(s=>s.codec_type==='video');
      const audio = output.streams.find(s=>s.codec_type==='audio');
      if (video?.codec_name !== 'h264' || !['yuv420p','yuvj420p'].includes(video.pix_fmt)
          || audio?.codec_name !== 'aac' || audio.channels !== 2) throw new Error('Output does not match the browser preset');
      for (const {stream,packets} of tracks) {
        const sampleDuration=Math.min(3,packets.duration);
        const seeks=[Math.max(0,packets.min),Math.max(0,packets.end-sampleDuration)];
        for (const seek of [...new Set(seeks)]) {
          const audioFilters=stream.codec_type==='audio'?['-af','asetpts=N/SR/TB']:[];
          let decoded='',diagnostics='';
          await controlledRun('ffmpeg',['-v','error','-nostdin','-ss',String(seek),'-i',tempPath,
            '-t',String(sampleDuration),'-map',`0:${stream.index}`,...audioFilters,
            '-progress','pipe:1','-nostats','-f','null','-'],{
              onStdout:chunk=>{decoded+=String(chunk);if(decoded.length>65536)throw new Error('Decode progress exceeded its expected bound');},
              onStderr:chunk=>{if(diagnostics.length<4096)diagnostics+=String(chunk).slice(0,4096-diagnostics.length);},
            });
          verifyDecodeDiagnostics(diagnostics,stream,seek);
          verifyDecodedSample(decoded,stream,seek,sampleDuration);
        }
      }
      checkCancelled();
      const latest = fs.statSync(filePath);
      if (latest.size!==originalStat.size || latest.mtimeMs!==originalStat.mtimeMs) throw new Error('Source changed during conversion');
      if (getActiveTranscodeFilePaths().has(filePath)) throw new Error('Playback started on this file; keeping the original');
      if (fs.existsSync(retainedPath) || (newPath !== filePath && fs.existsSync(newPath))) {
        throw new Error('A destination appeared during conversion; original untouched');
      }
      const outputSize = fs.statSync(tempPath).size;
      if(outputSize<1024) throw new Error('Output too small');
      progress.stage = 'Saving verified file';
      fs.mkdirSync(path.dirname(retainedPath),{recursive:true});
      fs.renameSync(filePath,retainedPath);originalMoved=true;
      fs.renameSync(tempPath,newPath);outputPlaced=true;
      // Conversion date must not be inferred from the original movie's old mtime.
      fs.writeFileSync(retainedPath+'.conversion.json',JSON.stringify({retainedAt:Date.now(),newPath}),{flag:'wx'});
      // A successful close/rename alone is not a durability boundary. Before
      // deleting the backup, persist the replacement and both rename dirs.
      if(settings.retainOriginals===false) {
        for(const target of [newPath,path.dirname(newPath),path.dirname(retainedPath)]) {
          const handle=await fs.promises.open(target,'r');
          try {await handle.sync();} finally {await handle.close();}
        }
      }
      for (const profileId of profileIds()) {
        const before = loadProfileData(profileId);
        const migrated = migrateProfileIds(before,oldId,newId);
        if(migrated.touched) {
          if(!saveProfileDataStrict)throw new Error('Strict profile persistence is unavailable; original retained');
          savedProfiles.push(profileId);
          await saveProfileDataStrict(profileId,migrated.data);
        }
      }
      checkCancelled();
      for (const cache of [probeCache,pixFmtCache,audioProbeCache,audioTracksCache,subProbeCache,heightCache,levelCache]) {
        savedCaches.push([cache,Object.hasOwn(cache,filePath),cache[filePath],Object.hasOwn(cache,newPath),cache[newPath]]);
        delete cache[filePath];delete cache[newPath];
      }
      probeCache[newPath]='h264';pixFmtCache[newPath]=video.pix_fmt;audioProbeCache[newPath]='aac';
      audioTracksCache[newPath]=output.streams.filter(s=>s.codec_type==='audio').map(s=>({index:s.index,codec:s.codec_name,channels:s.channels,lang:s.tags?.language || '',title:s.tags?.title || ''}));
      heightCache[newPath]=video.height;levelCache[newPath]=video.level;subProbeCache[newPath]=[];
      markDirty();scheduleSaveMediaInfo();
      return {ok:true,filePath,newPath,oldId,newId,bytesBefore:pre.size,bytesAfter:outputSize,
        ...finalizeOriginal(retainedPath, settings.retainOriginals)};
    } catch(error) {
      for(const [cache,oldExists,oldValue,newExists,newValue] of savedCaches) {
        if(oldExists)cache[filePath]=oldValue;else delete cache[filePath];
        if(newExists)cache[newPath]=newValue;else delete cache[newPath];
      }
      let profileRecovery='';
      for (const id of savedProfiles.reverse()) {
        // Requests can update another title while a durable write is awaited.
        // Reverse this title's ID migration on the current data, preserving
        // those unrelated edits instead of restoring a whole stale snapshot.
        const data=migrateProfileIds(loadProfileData(id),newId,oldId).data;
        try {await saveProfileDataStrict(id,data);}
        catch(rollbackError) {
          try {saveProfileData(id,data);} catch {}
          profileRecovery=`; profile ${id} recovery failed: ${rollbackError.message}`;log(profileRecovery);
        }
      }
      let mediaRecovery='';
      try {
        if (originalMoved) {
          if (outputPlaced) fs.unlinkSync(newPath);
          fs.renameSync(retainedPath,filePath);
          try {fs.unlinkSync(retainedPath+'.conversion.json');} catch {}
        }
      } catch(rollbackError) {mediaRecovery=`; recovery needed, original retained at ${retainedPath}: ${rollbackError.message}`;log(mediaRecovery);}
      try {fs.unlinkSync(tempPath);} catch {}
      for(const file of written) {try {fs.unlinkSync(file);} catch {}}
      return {ok:false,filePath,reason:error.message+profileRecovery+mediaRecovery};
    } finally { progress=null; originals.invalidate(); }
  }

  const originals = require('./retained-originals')({ newPathFor });
  const listRetainedOriginals = originals.list;

  // The undo button. Puts the original back at its own path and removes the
  // converted file, reversing the id migration so watch progress follows.
  //
  // Deliberately does NOT delete the extracted .srt sidecars: nothing records
  // which sidecars this feature created versus which were already on disk, and
  // deleting a file the user supplied would be far worse than leaving a
  // duplicate subtitle option behind. The UI says so explicitly.
  function restoreOriginal(retainedPath) {
    originals.invalidate();
    if (!fs.existsSync(retainedPath)) return { ok: false, reason: 'retained original no longer exists' };
    const dir = path.dirname(path.dirname(retainedPath));      // strip .converted-originals
    const originalPath = path.join(dir, path.basename(retainedPath));
    const convertedPath = newPathFor(originalPath);

    if (originalPath !== convertedPath && fs.existsSync(originalPath)) {
      return { ok: false, reason: 'a file already exists at the original path — refusing to overwrite' };
    }
    if (getActiveTranscodeFilePaths().has(convertedPath)) {
      return { ok: false, reason: 'the converted file is currently being streamed' };
    }

    try {
      // Put the original back FIRST. If the process dies between these two
      // steps the library has both files, which a rescan resolves — strictly
      // better than a window where it has neither.
      const backup = tempPathFor(convertedPath);
      if (originalPath === convertedPath && fs.existsSync(convertedPath)) {
        if (fs.existsSync(backup)) return {ok:false,reason:'Temporary conversion file exists; stop conversion first'};
        fs.renameSync(convertedPath,backup);
        try {fs.renameSync(retainedPath,originalPath);} catch(err) {fs.renameSync(backup,convertedPath);throw err;}
        fs.unlinkSync(backup);
      } else {
        fs.renameSync(retainedPath, originalPath);
        if (fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
      }
      try {fs.unlinkSync(retainedPath+'.conversion.json');} catch {}

      for (const cache of [probeCache,pixFmtCache,audioProbeCache,audioTracksCache,subProbeCache,heightCache,levelCache]) {
        delete cache[convertedPath];delete cache[originalPath];
      }
      markDirty();
      scheduleSaveMediaInfo();

      const oldId = hashId(convertedPath);
      const newId = hashId(originalPath);
      const profilesMigrated = [];
      for (const profileId of profileIds()) {
        const data = loadProfileData(profileId);
        const { data: migrated, touched } = migrateProfileIds(data, oldId, newId);
        if (touched) { saveProfileData(profileId, migrated); profilesMigrated.push(profileId); }
      }

      // Clean up an empty retention dir so it does not linger as clutter.
      try {
        const retDir = path.dirname(retainedPath);
        if (fs.readdirSync(retDir).length === 0) fs.rmdirSync(retDir);
      } catch {}

      return { ok: true, originalPath, convertedPath, profilesMigrated };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  // Manual cleanup can include recent originals, but only enumerated library
  // backups with an existing replacement can be removed. Restrict execution
  // to the exact paths shown in the user's preview.
  async function cleanupExpiredOriginals(roots, keepDays, { dryRun = false, includeRecent = false, retainedPaths = null, canDelete = () => true } = {}) {
    const all = await listRetainedOriginals(roots, keepDays, { fresh: true });
    const selected = all.filter(o => (includeRecent || o.expired)
      && (retainedPaths === null || retainedPaths.includes(o.retainedPath)));
    const deletable = selected.filter(o => o.restorable);
    const keptBecauseOnlyCopy = selected.filter(o => !o.restorable);
    const deleted = [];
    let bytes = 0;

    if (!dryRun) {
      if (!canDelete()) throw new Error('Stop conversion before cleaning up originals');
      for (const o of deletable) {
        // Re-verify at the moment of deletion; the listing could be seconds
        // stale and this is not an operation to get wrong on stale data.
        if (!fs.existsSync(o.currentPath)) continue;
        try {
          fs.unlinkSync(o.retainedPath);
          try {fs.unlinkSync(o.retainedPath+'.conversion.json');} catch {}
          deleted.push(o.name);
          bytes += o.size;
          try {
            const dir = path.dirname(o.retainedPath);
            if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
          } catch {}
        } catch (err) {
          log(`cleanup failed for ${o.name}: ${err.message}`);
        }
      }
    }

    if (!dryRun) originals.invalidate();
    return {
      deleted: dryRun ? deletable.map((o) => o.name) : deleted,
      bytes: dryRun ? deletable.reduce((s, o) => s + o.size, 0) : bytes,
      candidates: deletable.length,
      retainedPaths: deletable.map(o => o.retainedPath),
      skippedOnlyCopy: keptBecauseOnlyCopy.map((o) => o.name),
      stillWithinWindow: all.filter((o) => !o.expired).length,
    };
  }

  return {
    convertContainerOnly, preflight, listRetainedOriginals, restoreOriginal,
    cleanupExpiredOriginals, killActive, convertCompatible, setPaused,
    invalidateOriginals: originals.invalidate,
    progress: () => progress ? {...progress} : null,
  };
};

module.exports.migrateProfileIds = migrateProfileIds;
module.exports.retainedPathFor = retainedPathFor;
module.exports.newPathFor = newPathFor;
module.exports.tempPathFor = tempPathFor;
module.exports.buildRemuxArgs = buildRemuxArgs;
module.exports.withResourceLimits = withResourceLimits;
module.exports.mediaDurationOf = mediaDurationOf;
module.exports.finalizeOriginal = finalizeOriginal;
