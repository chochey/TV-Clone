// Player plumbing kept out of the component: hls.js loading, WebVTT
// parsing, and time formatting.

// v1 serves its own hls.min.js and the proxy passes it through — load that
// copy on demand instead of vendoring a second one into the v2 bundle.
let hlsPromise = null;
export function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsPromise) {
    hlsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/hls.min.js';
      s.onload = () => resolve(window.Hls);
      s.onerror = () => { hlsPromise = null; reject(new Error('hls.js failed to load')); };
      document.head.appendChild(s);
    });
  }
  return hlsPromise;
}

// Minimal WebVTT parser — v1's /subtitle endpoints always emit VTT
// (srtToVtt handles conversion server-side). Returns [{start, end, text}].
function parseTimestamp(ts) {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/);
  if (!m) return null;
  return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2], 10) * 60) +
    parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

export function parseVtt(text) {
  const cues = [];
  // Normalize newlines, drop the WEBVTT header block
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) continue;
    const [rawStart, rawRest] = lines[i].split('-->');
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp((rawRest || '').trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const cueText = lines.slice(i + 1).join('\n')
      .replace(/<[^>]*>/g, '') // strip styling/voice tags
      .trim();
    if (cueText) cues.push({ start, end, text: cueText });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

// Active cue lookup — cue lists are small enough that linear scan is fine.
export function cueAt(cues, t) {
  for (const c of cues) {
    if (t < c.start) break;
    if (t < c.end) return c.text;
  }
  return '';
}

export function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
