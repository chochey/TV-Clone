// Decides when HEVC passthrough is visibly struggling and should give way to
// a transcode. Only passthrough is worth retreating from: a transcode already
// sends the easiest stream we can produce. The player counts presented frames
// (requestVideoFrameCallback) and passes the decoder's own counters; this
// judges them in windows and asks for a demotion only after sustained trouble.
export const QUALITY_WINDOW_MS = 6000;
export const QUALITY_GRACE_MS = 8000;    // a new session settles before it is judged
const BAD_WINDOWS_BEFORE_DEMOTING = 3;   // ~18 s of continuous breakage
const MIN_PRESENTED_FPS = 14;            // well under any real source (23.976 lowest)
const MAX_DROP_RATIO = 0.15;

export function createQualityWatchdog({ now = Date.now } = {}) {
  let frames = 0, windowAt = 0, base = null, badWindows = 0;
  const restartWindow = () => { windowAt = now(); badWindows = 0; frames = 0; };
  return {
    frame() { frames++; },
    // A new session: start-up and post-seek catch-up are never sampled.
    start() { frames = 0; windowAt = now() + QUALITY_GRACE_MS; base = null; badWindows = 0; },
    // Back from a hidden tab: the browser restarts the picture and catches up, which must never
    // count toward switching passthrough off for good. Same grace as a new session.
    resume() { frames = 0; windowAt = now() + QUALITY_GRACE_MS; base = null; badWindows = 0; },
    // state: active (passthrough, playing, no error or scrubbing), playbackRate,
    // readyState, hidden, quality ({ dropped, total } from the decoder, or null),
    // countsFrames (requestVideoFrameCallback is available).
    check(state) {
      if (!state.active || state.playbackRate !== 1) return { action: 'none' };
      // Buffering starves the screen for reasons unrelated to decode cost; that
      // is the stall watchdog's job.
      if (state.readyState < 3) { restartWindow(); return { action: 'none' }; }
      // Hidden tabs are throttled and their decoders report frames as dropped, so
      // neither the window nor the decoder baseline may carry across one.
      if (state.hidden) { restartWindow(); base = null; return { action: 'none' }; }
      const t = now();
      if (t - windowAt < QUALITY_WINDOW_MS) return { action: 'none' };
      const fps = frames / ((t - windowAt) / 1000);
      frames = 0; windowAt = t;
      // Corroborate with the decoder's own count where it is populated, so a browser
      // without a frame callback cannot be demoted on a count it never kept.
      let dropRatio = 0;
      const q = state.quality;
      if (q && q.total > 0) {
        if (base) {
          const dropped = q.dropped - base.dropped, total = q.total - base.total;
          if (total > 30) dropRatio = dropped / total;
        }
        base = { dropped: q.dropped, total: q.total };
      }
      const starved = state.countsFrames && fps > 0 && fps < MIN_PRESENTED_FPS;
      const dropping = dropRatio > MAX_DROP_RATIO;
      if (!starved && !dropping) { badWindows = 0; return { action: 'none' }; }
      if (++badWindows < BAD_WINDOWS_BEFORE_DEMOTING) return { action: 'none' };
      badWindows = 0;
      return { action: 'demote', reason: starved ? `only ${fps.toFixed(1)} fps reaching the screen` : `${Math.round(dropRatio * 100)}% of frames dropped` };
    },
  };
}
