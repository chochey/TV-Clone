// Does this browser actually decode HEVC?
//
// The capability APIs cannot be trusted for this. Measured on a Chromium build
// with a half-working VAAPI driver: canPlayType said "probably",
// MediaSource.isTypeSupported said true, and mediaCapabilities.decodingInfo
// reported supported + smooth + powerEfficient — and then the decoder failed
// with PIPELINE_ERROR_DECODE the moment a real frame arrived. Shipping
// passthrough off those answers would have handed people a black screen.
//
// So we decode real clips and confirm pixels came out of them. Each is a
// single GOP cut from the library with `-c:v copy`, so they are exactly the
// kind of data passthrough delivers: Main 10, hvc1-tagged, untouched bitstream.
//
// The answer is a *level*, not a yes/no, because the server refuses to pass
// through anything above what the browser demonstrably decoded.

// Clips are tried highest level first. HEVC levels are hierarchical, so a
// decoder that handles L5.1 necessarily handles L4.0 — meaning a capable
// browser downloads exactly one clip and stops. A browser that fails the high
// clip falls back to the low one rather than giving up on passthrough
// entirely. Both are Main 10 (the library is overwhelmingly 10-bit) and cut
// from real files with `-c:v copy`, so they are the same shape of data
// passthrough actually delivers.
//
// Levels are in ffprobe units (×3): 120 = L4.0, 153 = L5.1. Measured across a
// 150-file sample: 85% of the library is L4.0, and 10.7% sits above it, so the
// high clip is what unlocks that tail.
const PROBE_CLIPS = [
  { url: '/hevc-probe-l153.mp4', level: 153, mime: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
  { url: '/hevc-probe.mp4',      level: 120, mime: 'video/mp4; codecs="hvc1.2.4.L120.B0"' },
];

const STORAGE_KEY = 'v2HevcProbe';
// Bump whenever the clip set or the pass/fail rule changes. Without this, a
// browser that cached a verdict under the old single-clip probe would keep
// reporting the old ceiling forever — the UA has not changed, so nothing else
// would ever invalidate it, and the higher tier would go unused.
const PROBE_VERSION = 2;
// Browsers gain and lose codec support across versions, and a GPU driver
// change can flip it without the version moving. Re-probing on a new UA string
// is cheap insurance; the clips are small and this runs once per browser build.
const probeIdentity = () => `v${PROBE_VERSION}|${navigator.userAgent}`;

function readCached() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && raw.ua === probeIdentity()) return raw;
  } catch {}
  return null;
}

function writeCached(level, reason) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ua: probeIdentity(), level, reason, at: Date.now(),
    }));
  } catch {}
}

// Called when a passthrough session fails to play. Reality disagreed with the
// probe, so the claimed ceiling comes down — but only by one step. A file that
// failed at L5.1 says nothing about whether L4.0 works, and the L4.0 tier is
// 85% of the library, so abandoning it on one bad file would give up most of
// the benefit. Falls to 0 (no passthrough at all) once the lowest tier fails.
export function demoteHevc(reason = 'playback failed') {
  const current = readCached()?.level ?? 0;
  const lower = PROBE_CLIPS
    .map((c) => c.level)
    .filter((l) => l < current)
    .sort((a, b) => b - a);
  const next = lower.length ? lower[0] : 0;
  writeCached(next, reason);
  return next;
}

let inflight = null;

/**
 * Highest HEVC level this browser has actually decoded. 0 means "do not pass
 * HEVC through". Result is cached per browser build; never throws.
 */
export function hevcMaxLevel() {
  const cached = readCached();
  if (cached) return Promise.resolve(cached.level);
  if (inflight) return inflight;
  inflight = runProbe()
    .then((level) => { writeCached(level, level ? 'decoded' : 'no picture'); return level; })
    .catch(() => { writeCached(0, 'probe error'); return 0; })
    .finally(() => { inflight = null; });
  return inflight;
}

async function runProbe() {
  // Highest first: the first clip that genuinely decodes sets the ceiling, and
  // everything below it is implied.
  for (const clip of PROBE_CLIPS) {
    if (await decodes(clip)) return clip.level;
  }
  return 0;
}

async function decodes(clip) {
  // A negative answer from the APIs is still worth honouring — they
  // under-report far less often than they over-report, and it saves the
  // download entirely. A positive answer proves nothing, so it is not trusted.
  if (window.MediaSource && !MediaSource.isTypeSupported(clip.mime)) {
    const v = document.createElement('video');
    if (!v.canPlayType(clip.mime)) return false;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // Kept out of the layout and out of the accessibility tree, but NOT
  // display:none — some browsers refuse to decode a hidden element.
  video.setAttribute('aria-hidden', 'true');
  Object.assign(video.style, {
    position: 'fixed', left: '-9999px', top: '0',
    width: '2px', height: '2px', opacity: '0', pointerEvents: 'none',
  });
  document.body.appendChild(video);

  try {
    video.src = clip.url;
    const loaded = await new Promise((resolve) => {
      const done = (ok) => { clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => done(false), 8000);
      video.addEventListener('loadeddata', () => done(true), { once: true });
      video.addEventListener('error', () => done(false), { once: true });
    });
    if (!loaded || !video.videoWidth) return false;

    try { await video.play(); } catch {}

    // requestVideoFrameCallback fires only when a frame is genuinely presented.
    // Where it exists it is the strongest signal available.
    let presented = false;
    if (video.requestVideoFrameCallback) {
      presented = await Promise.race([
        new Promise((r) => video.requestVideoFrameCallback(() => r(true))),
        new Promise((r) => setTimeout(() => r(false), 4000)),
      ]);
    } else {
      await new Promise((r) => setTimeout(r, 1200));
    }

    // Corroborate with actual pixels. A decoder that failed leaves the canvas
    // uniform; both clips were chosen to span a luminance range well over 100.
    let spread = 0;
    try {
      const c = document.createElement('canvas');
      c.width = 48; c.height = 27;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let min = 255, max = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      spread = max - min;
    } catch { spread = 0; }

    return spread > 6 || presented;
  } finally {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
    video.remove();
  }
}
