// After returning to a hidden tab, is the picture behind the sound?
//
// Firefox stops decoding a hidden tab's video after 10 s and keeps the audio going (Chrome does
// something similar). On return the picture restarts from a keyframe and is meant to catch up;
// measured on Firefox for Windows with 10-bit HEVC passthrough, it stayed behind the sound until
// the page was refreshed. requestVideoFrameCallback reports the media time of every frame that
// reaches the screen, so comparing it with the playback clock measures exactly that lag.
//
// Only acts after a return to the tab, and at most twice per return: first a jump to the current
// position (cheap, resyncs both tracks at the nearest keyframe), then, if the picture is still
// behind, a rebuild of the stream at the same spot, which is what the refresh did.
export const LAG_S = 0.5;              // a frame or two of slack is normal; half a second is visible
const MIN_FPS = 10;                    // the sound moved a second but almost no frames arrived
const SETTLE_CHECKS = 2;               // give the browser's own catch-up a couple of seconds
const BAD_CHECKS = 2;                  // two bad seconds in a row before acting
const WATCH_CHECKS = 20;               // seconds of playing after a return that are watched
const GOOD_TO_STOP = 4;                // after a jump, this many good seconds end the watch

export function createResumeSync() {
  let armed = false, stage = 0, played = 0, bad = 0, good = 0, lastCt = null, lags = [];
  const disarm = () => { armed = false; lags = []; lastCt = null; };
  return {
    hidden() { disarm(); },
    shown() { armed = true; stage = 0; played = 0; bad = 0; good = 0; lastCt = null; lags = []; },
    frame(mediaTime, currentTime) {
      if (armed && Number.isFinite(mediaTime) && Number.isFinite(currentTime)) lags.push(currentTime - mediaTime);
    },
    // playing: visible, unpaused, not buffering or starting up. currentTime: the media clock.
    check({ playing, currentTime }) {
      if (!armed) { lags = []; return { action: 'none' }; }
      if (!playing) { lags = []; lastCt = null; return { action: 'none' }; }
      const frames = lags.length;
      const sorted = [...lags].sort((a, b) => a - b);
      const medianLag = frames ? sorted[Math.floor(frames / 2)] : 0;
      const advanced = lastCt === null ? 0 : currentTime - lastCt;
      lags = []; lastCt = currentTime;
      if (++played <= SETTLE_CHECKS) return { action: 'none' };
      const behind = (frames > 0 && medianLag > LAG_S) || (advanced >= 0.7 && frames < MIN_FPS);
      if (!behind) {
        bad = 0;
        if (stage > 0 && ++good >= GOOD_TO_STOP) disarm();
        else if (stage === 0 && played > WATCH_CHECKS) disarm();
        return { action: 'none' };
      }
      good = 0;
      if (++bad < BAD_CHECKS) return { action: 'none' };
      bad = 0;
      stage++;
      if (stage === 1) { played = 0; return { action: 'resync' }; }   // the jump gets its own settle
      disarm();
      return { action: 'rebuild' };
    },
  };
}
