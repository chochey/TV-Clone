// Does this browser actually decode HEVC?
//
// The capability APIs cannot be trusted for this. Measured on a Chromium build
// with a half-working VAAPI driver: canPlayType said "probably",
// MediaSource.isTypeSupported said true, and mediaCapabilities.decodingInfo
// reported supported + smooth + powerEfficient — and then the decoder failed
// with PIPELINE_ERROR_DECODE the moment a real frame arrived. Shipping
// passthrough off those answers would have handed people a black screen.
//
// So we decode a real clip and confirm pixels came out of it. The clip is one
// GOP cut from the library with `-c:v copy`, so it is exactly the kind of data
// passthrough would deliver: Main 10, level 4.0, 1920x816, hvc1-tagged.

const PROBE_URL = '/hevc-probe.mp4';
const PROBE_MIME = 'video/mp4; codecs="hvc1.2.4.L120.B0"';

// The level the probe clip proves, in ffprobe units (×3, so 120 is L4.0). The
// server refuses passthrough above whatever we report here, which is why this
// is the clip's real level and not a guess — a decoder that handles L4.0 has
// not thereby shown it handles the L5.1 files in the library.
export const PROBE_LEVEL = 120;

const STORAGE_KEY = 'v2HevcProbe';
// Browsers gain and lose codec support across versions, and a GPU driver
// change can flip it without the version moving. Re-probing on a new UA string
// is cheap insurance; the clip is 45 KB and this runs once per browser build.
const probeIdentity = () => navigator.userAgent;

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

// Called when a passthrough session fails to play. Whatever the probe decided,
// reality disagreed — so stop claiming the capability for this browser.
export function markHevcBroken(reason = 'playback failed') {
  writeCached(0, reason);
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
  // A negative answer from the APIs is still worth honouring — they
  // under-report far less often than they over-report, and it saves the
  // download entirely.
  if (window.MediaSource && !MediaSource.isTypeSupported(PROBE_MIME)) {
    const v = document.createElement('video');
    if (!v.canPlayType(PROBE_MIME)) return 0;
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
    video.src = PROBE_URL;
    const loaded = await new Promise((resolve) => {
      const done = (ok) => { clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => done(false), 8000);
      video.addEventListener('loadeddata', () => done(true), { once: true });
      video.addEventListener('error', () => done(false), { once: true });
    });
    if (!loaded || !video.videoWidth) return 0;

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
    // uniform; this clip is a dark scene but still spans a range of ~178.
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

    return (spread > 6 || presented) ? PROBE_LEVEL : 0;
  } finally {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
    video.remove();
  }
}
