// Backdrop stills: extract a landscape frame from the actual media file so
// the v2 hero has real cinematic art (OMDb only provides portrait posters).
// Frames are grabbed ~25% into the runtime (past logos/intros), tonemapped
// to SDR when the source is HDR, and cached to data/backdrops/<id>.jpg
// forever. Factory module.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BACKDROP_WIDTH = 1280;
const EXTRACT_TIMEOUT_MS = 45000; // generous: cold USB drives spin up slowly
const MAX_CONCURRENT = 2;         // don't stack ffmpeg on top of live transcodes
const FAIL_RETRY_MS = 60 * 60 * 1000;

// HDR transfer characteristics that need tonemapping before an SDR JPEG
// reads right (PQ / HLG). Everything else goes straight to scale.
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

// Land in the meat of the film: 25% of runtime, never inside the first
// minute (studio logos) or the last two (credits). Unknown duration falls
// back to 5 minutes in.
function pickTimestamp(duration) {
  if (!duration || duration <= 0) return 300;
  const ts = duration * 0.25;
  const latest = Math.max(1, duration - 120);
  return Math.round(Math.min(Math.max(ts, Math.min(60, latest)), latest));
}

function buildVf(isHdr) {
  const scale = `scale=${BACKDROP_WIDTH}:-2`;
  if (!isHdr) return scale;
  // Downscale first (cheap), then linearize -> hable tonemap -> BT.709.
  return `${scale},zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,` +
    'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
}

function ffmpegArgs(filePath, ts, vf, outPath) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(ts), '-i', filePath,
    '-map', '0:v:0', '-frames:v', '1',
    '-vf', vf, '-q:v', '3', '-y', outPath,
  ];
}

module.exports = function createBackdrop({ DATA_DIR, probeDurationAsync }) {
  const BACKDROP_DIR = path.join(DATA_DIR, 'backdrops');
  if (!fs.existsSync(BACKDROP_DIR)) fs.mkdirSync(BACKDROP_DIR, { recursive: true });
  // Clean up temp files from interrupted extractions
  try {
    for (const entry of fs.readdirSync(BACKDROP_DIR)) {
      if (entry.startsWith('_tmp_')) {
        try { fs.rmSync(path.join(BACKDROP_DIR, entry), { force: true }); } catch {}
      }
    }
  } catch {}

  const inFlight = new Map();  // id -> Promise<string|null>
  const failedAt = new Map();  // id -> timestamp of last failure

  // Tiny semaphore so at most MAX_CONCURRENT ffmpegs run at once.
  let active = 0;
  const waiters = [];
  const acquire = () => {
    if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
    return new Promise((r) => waiters.push(r)).then(() => { active++; });
  };
  const release = () => { active--; const w = waiters.shift(); if (w) w(); };

  function probeTransfer(filePath) {
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=color_transfer', '-of', 'json', filePath,
      ]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.on('close', () => {
        try { resolve(JSON.parse(out).streams?.[0]?.color_transfer || ''); }
        catch { resolve(''); }
      });
      proc.on('error', () => resolve(''));
    });
  }

  function extract(filePath, ts, vf, outPath) {
    return new Promise((resolve) => {
      const tmp = path.join(BACKDROP_DIR, `_tmp_${path.basename(outPath)}`);
      const proc = spawn('ffmpeg', ffmpegArgs(filePath, ts, vf, tmp));
      let err = '';
      proc.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, EXTRACT_TIMEOUT_MS);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
          try { fs.renameSync(tmp, outPath); return resolve(outPath); } catch {}
        }
        try { fs.rmSync(tmp, { force: true }); } catch {}
        resolve(null);
      });
      proc.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  // Returns the cached jpg path, extracting it first if needed; null when the
  // file can't produce a frame (corrupt, missing, ffmpeg failure).
  function getBackdrop(id, filePath) {
    const safeId = path.basename(id); // ids are library-index hashes; belt and braces
    const outPath = path.join(BACKDROP_DIR, `${safeId}.jpg`);
    if (fs.existsSync(outPath)) return Promise.resolve(outPath);

    const lastFail = failedAt.get(safeId);
    if (lastFail && Date.now() - lastFail < FAIL_RETRY_MS) return Promise.resolve(null);

    if (inFlight.has(safeId)) return inFlight.get(safeId);

    const job = (async () => {
      await acquire();
      try {
        const [duration, transfer] = await Promise.all([
          probeDurationAsync(filePath),
          probeTransfer(filePath),
        ]);
        const ts = pickTimestamp(duration);
        const vf = buildVf(HDR_TRANSFERS.has(transfer));
        const result = await extract(filePath, ts, vf, outPath);
        if (result) failedAt.delete(safeId);
        else failedAt.set(safeId, Date.now());
        return result;
      } finally {
        release();
        inFlight.delete(safeId);
      }
    })();
    inFlight.set(safeId, job);
    return job;
  }

  return { getBackdrop, BACKDROP_DIR };
};

// Pure helpers exported for unit tests.
module.exports.pickTimestamp = pickTimestamp;
module.exports.buildVf = buildVf;
module.exports.ffmpegArgs = ffmpegArgs;
module.exports.HDR_TRANSFERS = HDR_TRANSFERS;
module.exports.BACKDROP_WIDTH = BACKDROP_WIDTH;
