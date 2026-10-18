// Player volume: 0–100% is the element's own volume; 101–150% routes the audio
// through a Web Audio gain stage, built only the first time someone goes past
// 100 (it takes over the element's output for the rest of the visit).
export const MAX_VOLUME = 150;
const clampPct = pct => Math.max(0, Math.min(MAX_VOLUME, Math.round(pct)));

export function createVolumeBoost({ getVideo, AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
  save = pct => localStorage.setItem('playerVolumePct', String(pct)) } = {}) {
  let ctx = null, gainNode = null;

  function ensureGraph() {
    const video = getVideo();
    if (ctx || !video || !AudioContext) return;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(video);
      gainNode = ctx.createGain();
      src.connect(gainNode);
      gainNode.connect(ctx.destination);
    } catch { ctx = null; gainNode = null; }
  }

  function set(pct) {
    const video = getVideo();
    const volume = clampPct(pct);
    const v = volume / 100;
    const muted = volume === 0;
    video.volume = Math.min(1, v);
    video.muted = muted;
    if (v > 1) ensureGraph();
    if (gainNode) gainNode.gain.value = muted ? 0 : Math.max(1, v);
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    save(volume);
    return { volume, muted };
  }

  function setMuted(muted, volume) {
    getVideo().muted = muted;
    if (gainNode) gainNode.gain.value = muted ? 0 : Math.max(1, volume / 100);
    return muted;
  }

  function close() { if (ctx) { try { ctx.close(); } catch {} } }

  return { set, setMuted, close };
}

// The remembered level: the percent key, else the old 0–1 'playerVolume' key.
export function savedVolumePercent(storage = localStorage) {
  let pct = parseFloat(storage.getItem('playerVolumePct'));
  if (isNaN(pct)) {
    const legacy = parseFloat(storage.getItem('playerVolume'));
    pct = isNaN(legacy) ? 100 : legacy * 100;
  }
  return clampPct(pct);
}
