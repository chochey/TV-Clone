// Settings storage for the library-conversion feature (MEDIA_CONVERSION_PLAN.md).
// Phase 1 only reads and persists these — nothing here starts a job. Kept
// separate from conversion-plan.js because that module is pure classification
// and this one is IO + validation, the same split probe.js/ffmpeg-args.js use.

const path = require('path');

const DEFAULTS = {
  enabled: false,                              // must be switched on deliberately
  tiers: { container: true, audio: true, legacy: false },
  concurrency: 1,
  niceness: 19,
  ffmpegThreads: 2,
  pauseWhilePlaying: true,
  schedule: { start: '02:00', end: '08:00' },   // empty start/end = anytime
  minFreeSpaceGB: 200,
  maxFilesPerRun: 200,
  keepOriginalsDays: 14,
  retainedBudgetGB: 400,
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clamp(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

// Whitelist + clamp rather than trust the request body directly — this is an
// admin-only route, but a stray typo (a string where a number belongs, an
// out-of-range concurrency) should not silently corrupt the file that a
// future conversion worker reads to decide how hard to run.
function sanitize(input, current) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...current };

  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;

  if (src.tiers && typeof src.tiers === 'object') {
    out.tiers = { ...current.tiers };
    for (const k of ['container', 'audio', 'legacy']) {
      if (typeof src.tiers[k] === 'boolean') out.tiers[k] = src.tiers[k];
    }
  }

  if (src.concurrency !== undefined) out.concurrency = Math.round(clamp(src.concurrency, 1, 4, current.concurrency));
  if (src.niceness !== undefined) out.niceness = Math.round(clamp(src.niceness, 0, 19, current.niceness));
  if (src.ffmpegThreads !== undefined) out.ffmpegThreads = Math.round(clamp(src.ffmpegThreads, 1, 6, current.ffmpegThreads));
  if (typeof src.pauseWhilePlaying === 'boolean') out.pauseWhilePlaying = src.pauseWhilePlaying;

  if (src.schedule && typeof src.schedule === 'object') {
    const start = String(src.schedule.start ?? '');
    const end = String(src.schedule.end ?? '');
    // Both empty means "anytime"; anything else must be two valid HH:MM values.
    if ((start === '' && end === '') || (TIME_RE.test(start) && TIME_RE.test(end))) {
      out.schedule = { start, end };
    }
  }

  if (src.minFreeSpaceGB !== undefined) out.minFreeSpaceGB = Math.round(clamp(src.minFreeSpaceGB, 10, 5000, current.minFreeSpaceGB));
  if (src.maxFilesPerRun !== undefined) out.maxFilesPerRun = Math.round(clamp(src.maxFilesPerRun, 1, 2000, current.maxFilesPerRun));
  if (src.keepOriginalsDays !== undefined) out.keepOriginalsDays = Math.round(clamp(src.keepOriginalsDays, 1, 90, current.keepOriginalsDays));
  if (src.retainedBudgetGB !== undefined) out.retainedBudgetGB = Math.round(clamp(src.retainedBudgetGB, 10, 10000, current.retainedBudgetGB));

  return out;
}

module.exports = function createConversionConfig({ DATA_DIR, loadJSON, saveJSON }) {
  const CONFIG_FILE = path.join(DATA_DIR, 'conversion.json');
  let config = { ...DEFAULTS, ...loadJSON(CONFIG_FILE, {}) };
  // Guard against a partially-written or hand-edited file introducing bad
  // shapes (e.g. tiers as an array) — re-sanitize on load, not just on PUT.
  config = sanitize(config, DEFAULTS);

  function get() {
    return config;
  }

  function update(input) {
    config = sanitize(input, config);
    saveJSON(CONFIG_FILE, config);
    return config;
  }

  return { get, update, DEFAULTS };
};

module.exports.sanitize = sanitize;
module.exports.DEFAULTS = DEFAULTS;
