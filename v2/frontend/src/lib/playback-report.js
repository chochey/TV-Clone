// What a viewing was like, sent to the server when the player closes (shown on
// the dashboard's streaming card): time from opening to the first frame,
// stalls while playing (waits within 3 s of a seek are the seek, counted
// separately) and time actually spent playing.
const SEEK_GRACE_MS = 3000;

export function createPlaybackReport({ now = () => performance.now() } = {}) {
  const openedAt = now();
  let startupMs = null, playingSince = null, watchedMs = 0;
  let waitingSince = null, waitIsSeek = false, lastSeekAt = -Infinity;
  let rebuffers = 0, rebufferMs = 0, seekWaitMs = 0, failed = false;

  const stopPlaying = () => { if (playingSince != null) { watchedMs += now() - playingSince; playingSince = null; } };
  const endWait = () => {
    if (waitingSince == null) return;
    const ms = now() - waitingSince;
    if (waitIsSeek) seekWaitMs += ms; else { rebuffers++; rebufferMs += ms; }
    waitingSince = null;
  };

  return {
    playing() {
      if (startupMs == null) startupMs = now() - openedAt;
      endWait();
      if (playingSince == null) playingSince = now();
    },
    paused() { endWait(); stopPlaying(); },
    seeking() { lastSeekAt = now(); },
    waiting() {
      if (startupMs == null) return; // still starting up
      stopPlaying();
      if (waitingSince == null) { waitingSince = now(); waitIsSeek = now() - lastSeekAt <= SEEK_GRACE_MS; }
    },
    failed() { if (startupMs == null) { failed = true; startupMs = now() - openedAt; } },
    worthSending() {
      return failed || watchedMs + (playingSince != null ? now() - playingSince : 0) >= 5000;
    },
    finish({ itemId, direct, playbackId, quality }) {
      const live = playingSince != null ? now() - playingSince : 0;
      return { itemId, direct, playbackId, quality, startupMs: Math.round(startupMs ?? 0), rebuffers, rebufferMs: Math.round(rebufferMs),
        seekWaitMs: Math.round(seekWaitMs), watchedMs: Math.round(watchedMs + live), failed };
    },
  };
}
