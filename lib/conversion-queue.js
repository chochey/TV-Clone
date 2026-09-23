// Phase 3 of MEDIA_CONVERSION_PLAN.md — the background conversion queue.
//
// Replaces the phase-2 pilot's hardcoded ten-file list and, critically, its
// blocking execution: the pilot ran inside the HTTP request and held the
// connection ~100s for ten files, which would time out long before finishing
// the 981 that remain. Here start() returns immediately and the run proceeds
// in the background; the UI polls /status.
//
// The state machine is deliberately small — idle | running | paused | stopping
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

module.exports = function createConversionQueue({
  worker,              // { convertContainerOnly, killActive }
  getConfig,           // () => conversion config
  getEligibleFiles,    // (config) => string[] absolute paths, already tier-filtered
  isPlaybackActive,    // () => boolean
  getFileSize = () => 0,
  getRetainedBytes,    // () => number, total bytes currently held as originals
  onFileComplete = () => {}, // refresh the library after each verified replacement
  onBatchComplete,     // () => void — library invalidation, once per run
  log = () => {},
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let status = 'idle';          // idle | running | paused | stopping
  let queue = [];
  let cursor = 0;
  let current = null;           // file path in flight
  let results = [];             // newest-first, capped
  let startedAt = 0;
  let waitingReason = '';       // why a running queue is not converting right now
  let lastError = '';
  let converted = 0;
  let failed = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  let loopRunning = false;
  let wake = () => {};
  async function wait(ms) { await Promise.race([sleep(ms), new Promise(resolve => { wake = resolve; })]); }

  const MAX_RESULTS = 200;      // the UI only ever shows a tail of these

  function snapshot() {
    return {
      status,
      progress: worker.progress?.() || null,
      total: queue.length,
      done: cursor,
      remaining: Math.max(0, queue.length - cursor),
      current: current ? current.split('/').pop() : null,
      currentPath: current,
      waitingReason,
      converted,
      failed,
      bytesBefore,
      bytesAfter,
      startedAt,
      lastError,
      results: results.slice(0, 40),
    };
  }

  // Everything that can stall a running queue, checked in priority order.
  // Returns '' when it is clear to convert.
  async function blockedReason() {
    const cfg = getConfig();
    if (cfg.enabled === false) return 'conversion is disabled';
    if (cfg.pauseWhilePlaying && isPlaybackActive()) return 'someone is watching';
    if (!withinSchedule(cfg.schedule, now())) {
      return `outside the ${cfg.schedule.start}–${cfg.schedule.end} window`;
    }
    const budget = cfg.retainedBudgetGB * 1e9;
    if (getRetainedBytes() + (queue[cursor] ? getFileSize(queue[cursor]) : 0) >= budget) {
      return `retention budget reached (${cfg.retainedBudgetGB} GB of originals held)`;
    }
    return '';
  }

  async function loop() {
    if (loopRunning) return;
    loopRunning = true;
    try {
      while (status === 'running' && cursor < queue.length) {
        const reason = await blockedReason();
        if (reason) {
          // Park rather than burn the queue down: re-check on an interval so
          // the run resumes by itself when the window opens or playback ends.
          if (waitingReason !== reason) log(`waiting — ${reason}`);
          waitingReason = reason;
          await wait(MINUTE);
          continue;
        }
        waitingReason = '';

        if (status !== 'running') break;
        const filePath = queue[cursor];
        current = filePath;
        const monitor = setInterval(() => {
          const cfg = getConfig();
          const autoReason = cfg.enabled === false ? 'conversion is disabled'
            : cfg.pauseWhilePlaying && isPlaybackActive() ? 'someone is watching'
            : !withinSchedule(cfg.schedule, now()) ? 'outside the scheduled window' : '';
          waitingReason = autoReason;
          worker.setPaused?.(status === 'paused' || !!autoReason);
        }, 1000);
        let result;
        try {
          worker.setPaused?.(false);
          result = await (worker.convertCompatible || worker.convertContainerOnly)(filePath);
        } finally { clearInterval(monitor); }

        // A stop that landed mid-file kills ffmpeg, which surfaces here as an
        // ordinary failure. Don't record it as one — the file is untouched.
        if (status === 'stopping') { current = null; break; }

        cursor++;
        current = null;
        if (result.ok) {
          converted++;
          try { onFileComplete(result); } catch (error) { log(`Library refresh failed: ${error.message}`); }
          bytesBefore += result.bytesBefore || 0;
          bytesAfter += result.bytesAfter || 0;
        } else {
          failed++;
        }
        results.unshift({
          name: filePath.split('/').pop(),
          ok: result.ok,
          reason: result.reason || '',
          at: Date.now(),
        });
        if (results.length > MAX_RESULTS) results.length = MAX_RESULTS;
        log(`${result.ok ? 'OK' : 'SKIP'} ${filePath.split('/').pop()}${result.ok ? '' : ` — ${result.reason}`}`);
      }
    } catch (err) {
      lastError = err.message;
      status = 'stopping';
      log(`queue error: ${err.message}`);
    } finally {
      loopRunning = false;
      current = null;
      const finished = cursor >= queue.length && status === 'running';
      if (finished || status === 'stopping') {
        if (converted > 0) { try { onBatchComplete(); } catch {} }
        log(`run ${finished ? 'complete' : 'stopped'}: ${converted} converted, ${failed} skipped`);
        status = 'idle';
        waitingReason = '';
      }
    }
  }

  function start() {
    if (status === 'stopping' || (status === 'idle' && loopRunning)) return {ok:false,error:'Wait for the current job to stop'};
    if (status === 'running') return { ok: false, error: 'Already running' };
    if (status === 'paused') return resume();

    const cfg = getConfig();
    if (cfg.enabled === false) return {ok:false,error:'Enable conversion before starting'};
    const eligible = getEligibleFiles(cfg);
    if (!eligible.length) return { ok: false, error: 'Nothing eligible to convert' };

    queue = eligible.slice(0, cfg.maxFilesPerRun);
    cursor = 0;
    results = [];
    converted = 0; failed = 0; bytesBefore = 0; bytesAfter = 0;
    lastError = ''; waitingReason = '';
    startedAt = Date.now();
    status = 'running';
    log(`starting — ${queue.length} file(s) queued${eligible.length > queue.length ? ` (of ${eligible.length} eligible; capped by maxFilesPerRun)` : ''}`);
    loop();                                  // deliberately not awaited
    return { ok: true, queued: queue.length, eligible: eligible.length };
  }

  // Pause lets the in-flight file finish. Killing a remux mid-write would be
  // safe (the temp file is discarded and the original never moves until the
  // swap) but pointlessly throws away up to a minute of completed work for a
  // button whose whole meaning is "stop soon, gently".
  function pause() {
    if (status !== 'running') return { ok: false, error: `Cannot pause while ${status}` };
    status = 'paused';
    worker.setPaused?.(true); wake();
    log('paused — current conversion is suspended');
    return { ok: true };
  }

  function resume() {
    if (status !== 'paused') return { ok: false, error: `Cannot resume while ${status}` };
    status = 'running';
    worker.setPaused?.(false); wake();
    log('resumed');
    loop();
    return { ok: true };
  }

  // Stop is the abrupt one: it kills the running ffmpeg. Safe because the
  // worker only ever writes to a temp file until its verification passes, so
  // an interrupted conversion leaves the original exactly where it was.
  function stop() {
    if (status === 'idle') return { ok: false, error: 'Not running' };
    const wasPaused = status === 'paused';
    status = 'stopping';
    const killed = worker.killActive();
    wake();
    if (!current && wasPaused) {                          // no loop to notice the flag
      status = 'idle';
      if (converted > 0) { try { onBatchComplete(); } catch {} }
    }
    log(`stopping${killed ? ' — killed the in-flight conversion' : ''}`);
    return { ok: true, killedInFlight: killed };
  }

  return { start, pause, resume, stop, snapshot, configurationChanged: () => wake(), get status() { return status; } };
};

module.exports.withinSchedule = withinSchedule;
