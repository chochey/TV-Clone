const { spawn } = require('child_process');

// Both queued and running jobs have deadlines. A timed-out child keeps
// its slot until it actually exits, so an unresponsive drive cannot create
// an unlimited succession of stuck processes.
function createChildRunner({ spawnFn = spawn, concurrency = 2, maxQueued = 32,
  timeoutMs = 15000, maxStdoutBytes = 2 * 1024 * 1024,
  maxStderrBytes = 128 * 1024, killGraceMs = 1000 } = {}) {
  let active = 0;
  const queue = [];
  const error = (code, message) => Object.assign(new Error(message), { code });

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      if (job.settled) continue;
      clearTimeout(job.queueTimer);
      job.started = true;
      active++;
      let proc, timer, killTimer, released = false;
      let stdout = [], stderr = [], outBytes = 0, errBytes = 0;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        clearTimeout(timer);
        clearTimeout(killTimer);
        job.signal?.removeEventListener('abort', job.abort);
        pump();
      };
      const stop = err => {
        if (job.settled) return;
        err.stderr = Buffer.concat(stderr).toString('utf8');
        job.settle(err);
        stdout = []; stderr = [];
        clearTimeout(timer);
        try { proc?.kill('SIGTERM'); } catch {}
        if (!released) {
          killTimer = setTimeout(() => { try { proc?.kill('SIGKILL'); } catch {} }, killGraceMs);
          killTimer.unref?.();
        }
      };
      job.stop = stop;
      try {
        proc = spawnFn(job.command, job.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        job.settle(err); release(); continue;
      }
      const collect = (which, data) => {
        if (job.settled) return; // keep draining both pipes after cancellation
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (which === 'stdout') {
          outBytes += chunk.length;
          if (outBytes > job.maxStdoutBytes) return stop(error('MEDIA_OUTPUT_LIMIT', 'Media tool output exceeded its limit'));
          stdout.push(chunk);
        } else {
          errBytes += chunk.length;
          if (errBytes > job.maxStderrBytes) return stop(error('MEDIA_OUTPUT_LIMIT', 'Media tool error output exceeded its limit'));
          stderr.push(chunk);
        }
      };
      proc.stdout?.on('data', data => collect('stdout', data));
      proc.stderr?.on('data', data => collect('stderr', data));
      proc.on('error', err => { job.settle(err); release(); });
      proc.on('close', (code, signal) => {
        if (!job.settled) {
          const errText = Buffer.concat(stderr).toString('utf8');
          if (code !== 0) job.settle(Object.assign(error('MEDIA_EXIT', 'Media tool failed'), { exitCode: code, signal, stderr: errText }));
          else {
            const output = Buffer.concat(stdout);
            job.settle(null, { stdout: job.encoding === null ? output : output.toString(job.encoding), stderr: errText, code });
          }
        }
        release();
      });
      timer = setTimeout(() => stop(error('MEDIA_TIMEOUT', 'Media tool timed out')), job.timeoutMs);
      if (job.signal?.aborted) stop(error('ABORT_ERR', 'Media job cancelled'));
    }
  }

  function run(command, args, options = {}) {
    if (options.signal?.aborted) return Promise.reject(error('ABORT_ERR', 'Media job cancelled'));
    if (active >= concurrency && queue.length >= maxQueued) return Promise.reject(error('MEDIA_BUSY', 'Media processing is busy. Please try again.'));
    return new Promise((resolve, reject) => {
      const job = { command, args, signal: options.signal, encoding: options.encoding === null ? null : options.encoding || 'utf8',
        timeoutMs: options.timeoutMs || timeoutMs,
        maxStdoutBytes: options.maxStdoutBytes ?? maxStdoutBytes,
        maxStderrBytes: options.maxStderrBytes ?? maxStderrBytes,
        started: false, settled: false };
      job.settle = (err, result) => {
        if (job.settled) return;
        job.settled = true;
        clearTimeout(job.queueTimer);
        if (!job.started) job.signal?.removeEventListener('abort', job.abort);
        if (err) reject(err); else resolve(result);
      };
      job.abort = () => {
        if (job.started) job.stop?.(error('ABORT_ERR', 'Media job cancelled'));
        else {
          const at = queue.indexOf(job); if (at >= 0) queue.splice(at, 1);
          job.settle(error('ABORT_ERR', 'Media job cancelled'));
        }
      };
      job.signal?.addEventListener('abort', job.abort, { once: true });
      job.queueTimer = setTimeout(() => {
        const at = queue.indexOf(job); if (at >= 0) queue.splice(at, 1);
        job.settle(error('MEDIA_TIMEOUT', 'Timed out waiting for media processing'));
      }, options.queueTimeoutMs || job.timeoutMs);
      queue.push(job);
      pump();
    });
  }
  return { run, snapshot: () => ({ active, queued: queue.length }) };
}

const probeRunner = createChildRunner({ concurrency: 2 });
const subtitleRunner = createChildRunner({ concurrency: 1, maxQueued: 16, timeoutMs: 45000, maxStdoutBytes: 8 * 1024 * 1024 });
const imageRunner = createChildRunner({ concurrency: 2, maxQueued: 16, timeoutMs: 45000 });
module.exports = { createChildRunner, probeRunner, subtitleRunner, imageRunner };
