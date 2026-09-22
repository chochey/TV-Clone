export const STARTUP_ERROR = 'Playback could not start. Try again or choose a lower quality.';

// Request playback immediately: delaying play until a buffer threshold can
// lose autoplay permission. HLS controls how much stream must be available.
// The watchdog also covers a paused element with no decoded frames.
export function startPlayback(video, { isCurrent, onTimeout, onBlocked, timers = globalThis, timeoutMs = 15000 }) {
  let active = true;
  let timer;
  function cancel() {
    active = false;
    timers.clearTimeout(timer);
    video.removeEventListener('playing', cancel);
  }
  function handleError(error) {
    if (!active || !isCurrent()) return;
    if (error?.name === 'NotAllowedError') { cancel(); onBlocked(); }
    // Other errors may recover when data arrives; keep the watchdog running.
  }
  if (!isCurrent()) return cancel;
  video.addEventListener('playing', cancel);
  timer = timers.setTimeout(() => {
    if (!active || !isCurrent()) return cancel();
    // The playing event may have arrived before the listener was installed.
    const alreadyPlaying = !video.paused && video.readyState >= 3;
    cancel();
    if (!alreadyPlaying) onTimeout();
  }, timeoutMs);
  try {
    Promise.resolve(video.play()).then(cancel, handleError);
  } catch (error) { handleError(error); }
  return cancel;
}
