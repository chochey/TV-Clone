import { AUTO_WATCHED_PERCENT } from './series-playback.js';
import { startPlayback } from './playback-startup.js';

const AUDIO_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', flac: 'audio/flac',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac',
};

export function audioMimeType(item) {
  const extension = (item?.filename || '').split('.').pop().toLowerCase();
  return AUDIO_TYPES[extension] || '';
}

export const audioStreamUrl = item => `/stream/${encodeURIComponent(item.id)}`;

export function audioPlaybackIssue(item) {
  if (typeof item?.playbackIssue === 'string' && item.playbackIssue.trim()) return item.playbackIssue;
  const extension = (item?.filename || '').split('.').pop().toLowerCase();
  return ['aax', 'aa', 'aaxc'].includes(extension)
    ? 'Protected Audible files cannot be played here. Add an unprotected MP3, M4A or M4B audiobook.' : '';
}

export function audioPlaybackError(error) {
  return ({
    1: 'Audio loading was interrupted. Please retry.',
    2: 'Could not load this audio. Check the server connection and retry.',
    3: 'This browser could not decode the audio. Try another browser or a supported copy.',
    4: 'This audio file is unavailable or unsupported by this browser. Try another browser or a supported copy.',
  })[error?.code] || 'Could not play this audio. Please retry.';
}

export function audioResumePosition(progress = {}) {
  return Number.isFinite(progress.currentTime) && progress.currentTime >= 0
    && (progress.percent || 0) < AUTO_WATCHED_PERCENT ? progress.currentTime : 0;
}

export function audioProgressPayload(item, currentTime, duration, profile, ended = false) {
  if (!item?.id || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime) || currentTime < 0) return null;
  return { id: item.id, currentTime: ended ? duration : Math.min(currentTime, duration), duration, profile };
}

export function audioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600), m = Math.floor(whole / 60) % 60, s = whole % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
}

// Native audio only: no HLS session, video engine, sprite, or subtitle work.
export function startAudioPlayback(audio, item, start, options) {
  const issue = audioPlaybackIssue(item);
  if (issue) { options.onError?.(issue); return () => {}; }
  const mime = audioMimeType(item);
  if (mime && audio.canPlayType && !audio.canPlayType(mime)) {
    options.onError?.(`This browser does not support this audio format. Try another browser or a supported copy.`);
    return () => {};
  }
  let active = true;
  const isCurrent = () => active && options.isCurrent();
  const metadata = () => {
    if (!isCurrent()) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    audio.currentTime = duration > 0 && start >= duration ? 0 : Math.max(0, start);
    options.onMetadata?.(duration);
  };
  audio.pause();
  audio.addEventListener('loadedmetadata', metadata, { once: true });
  audio.src = audioStreamUrl(item);
  const cancelWatchdog = startPlayback(audio, { ...options, isCurrent });
  return () => {
    active = false;
    audio.removeEventListener('loadedmetadata', metadata);
    cancelWatchdog();
  };
}
