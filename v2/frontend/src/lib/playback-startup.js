export const STARTUP_ERROR = 'Playback is taking longer than expected. Keep waiting, retry, or choose a lower quality.';

// Request playback immediately: delaying play until a buffer threshold can
// lose autoplay permission. HLS controls how much stream must be available.
// The watchdog also covers a paused element with no decoded frames.
export function startPlayback(video, { isCurrent, onTimeout, onBlocked, onSlow, timers = globalThis, timeoutMs = 60000, slowMs = 15000 }) {
  let active = true;
  let timer, slowTimer;
  function cancel() {
    active = false;
    timers.clearTimeout(timer);
    timers.clearTimeout(slowTimer);
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
  if (onSlow) slowTimer = timers.setTimeout(() => {
    if (!active || !isCurrent()) return cancel();
    if (!video.paused && video.readyState >= 3) return cancel();
    onSlow();
  }, slowMs);
  try {
    Promise.resolve(video.play()).then(cancel, handleError);
  } catch (error) { handleError(error); }
  return cancel;
}

// Long first segments already provide a startup reserve. Requiring a second
// forces a live-playlist refresh that may take an entire target duration.
export function startupFragmentCount(playlist) {
  const seconds = Number(playlist.match(/#EXTINF:([\d.]+)/)?.[1]);
  return seconds >= 6 ? 1 : 2;
}

// The default startLoad() argument is -1 (live edge), even with startPosition:0.
// These EVENT playlists contain on-demand media starting at the requested seek.
export function startHlsFromPosition(hls, position = 0) {
  hls.startLoad(Number.isFinite(position) && position >= 0 ? position : 0);
}
