import { startPlayback } from './playback-startup.js';

// Cover the whole source load, including a request that never supplies metadata.
// Request play immediately so the browser can retain the viewer's gesture.
export function startDirectPlayback(video, src, start, options) {
  let active = true;
  const current = () => active && options.isCurrent();
  const metadata = () => {
    if (!current()) return;
    video.currentTime = start;
    options.onMetadata();
  };
  video.pause();
  video.addEventListener('loadedmetadata', metadata, { once: true });
  video.src = src;
  const cancelWatchdog = startPlayback(video, { ...options, isCurrent: current });
  return () => {
    active = false;
    video.removeEventListener('loadedmetadata', metadata);
    cancelWatchdog();
  };
}

export function directPlaybackError(error) {
  return ({
    1: 'Video loading was interrupted. Please retry.',
    2: 'Could not load this video. Check the server connection and retry.',
    3: 'This browser could not decode the video. Please retry or choose another copy.',
    4: 'This video is unavailable or unsupported by this browser. Please retry or choose another copy.',
  })[error?.code] || 'Could not play this video. Please retry.';
}
