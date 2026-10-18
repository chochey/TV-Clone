// Decides what to do when video that should be playing stops moving.
//
// hls.js gives up on a buffer stall without reporting it, so the player watches
// the clock itself (checked once a second). The decision matters most for HEVC
// passthrough: abandoning it means a full CPU decode and live H.264 encode for
// the rest of the visit, which is visibly laggy. Only one situation actually
// proves the passthrough stream is at fault: frozen with media buffered right
// ahead that the decoder will not reach even after hopping to it. Everything
// else is waiting for data (a resume after a pause restarts loading, a tab the
// browser put to sleep is catching up, the network hiccuped), and the right
// answer to that is to rebuild the same stream, not to swap it for a worse one.
export const STALL_AFTER_MS = 3000;
// Grace after returning to the tab or pressing play: the buffer refills and
// a backgrounded decoder re-primes before the clock moves again.
export const RESUME_GRACE_MS = 8000;

export function createStallWatchdog({ now = Date.now } = {}) {
  let lastPos = -1, lastPosAt = 0, frozenChecks = 0, quietUntil = 0;
  function reset(graceMs = 0) { lastPos = -1; frozenChecks = 0; quietUntil = now() + graceMs; }
  // state: active (meant to be playing: not paused, no error, not scrubbing or
  // starting up), hidden (tab not visible), position (seconds), aheadTarget
  // (start of buffered media within 30 s ahead, else -1), passthrough, direct.
  function check(state) {
    const t = now();
    // Hidden players are throttled by the browser and look frozen while fine.
    if (!state.active || state.hidden) { lastPos = -1; frozenChecks = 0; return { action: 'none' }; }
    if (t < quietUntil || lastPos < 0 || Math.abs(state.position - lastPos) > 0.05) {
      if (t >= quietUntil) frozenChecks = 0;
      lastPos = state.position; lastPosAt = t;
      return { action: 'none' };
    }
    if (t - lastPosAt < STALL_AFTER_MS) return { action: 'none' };
    lastPosAt = t;
    frozenChecks++;
    if (state.aheadTarget > 0 && frozenChecks <= 3) return { action: 'nudge', target: state.aheadTarget };
    if (frozenChecks <= 3) return { action: 'none' };
    frozenChecks = 0;
    if (state.direct) return { action: 'play' };
    return { action: state.passthrough && state.aheadTarget > 0 ? 'fallback' : 'rebuild' };
  }
  return { check, reset };
}
