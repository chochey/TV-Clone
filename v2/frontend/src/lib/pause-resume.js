// A pause bookmark survives media-source resets and delayed browser events.
export function createPauseBookmark() {
  let bookmark = null;
  return {
    capture(position, now = Date.now()) {
      if (Number.isFinite(position) && position >= 0) bookmark = { position, at: now };
    },
    seek(position) { if (bookmark && Number.isFinite(position) && position >= 0) bookmark.position = position; },
    take(fallback, now = Date.now()) {
      const result = bookmark ? { position: bookmark.position, expired: now - bookmark.at >= 60000 } : { position: fallback, expired: false };
      bookmark = null;
      return result;
    },
  };
}

// The server ends an encoded stream after two minutes without a request, and a paused player asks
// for nothing, so resuming used to reopen the stream and re-buffer from scratch. While paused the
// player asks the server to hold it (`ask` resolves true when held, false when the stream is gone or
// past the server's hold limit, and throws when there is no answer). held() is true only while the
// latest answer is a recent yes: every 45 s, with 90 s of slack for browsers that slow the timers
// of hidden tabs to once a minute, still inside the server's two minutes.
export const HOLD_EVERY_MS = 45000, HOLD_FRESH_MS = 90000;
export function createStreamHold({ ask, now = Date.now, every = HOLD_EVERY_MS, fresh = HOLD_FRESH_MS,
  schedule = (fn, ms) => setInterval(fn, ms), cancel = timer => clearInterval(timer) }) {
  let timer = null, last = null, generation = 0;
  function quiet() { if (timer !== null) cancel(timer); timer = null; }
  function stop() { generation++; quiet(); last = null; }
  function start(id) {
    stop();
    const mine = generation;
    const tick = async () => {
      let held;
      try { held = await ask(id); } catch { return; }   // no answer: the last one ages out
      if (mine !== generation) return;
      last = { held: !!held, at: now() };
      if (!held) quiet();
    };
    timer = schedule(tick, every);
    tick();
  }
  return { start, stop, held: () => !!last?.held && now() - last.at < fresh };
}

// What pressing play after a pause does: keep playing what is buffered, or reopen the stream.
// expired: paused for a minute or more; direct: a plain file, nothing on the server to lose;
// held: the server is still holding the stream; failed: the stream broke.
export function resumePlan({ expired, direct = false, held = false, failed = false }) {
  if (failed) return 'reopen';
  return !expired || direct || held ? 'buffer' : 'reopen';
}
