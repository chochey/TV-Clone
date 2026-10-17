// Data saver streams a smaller copy of an audiobook that the server makes on
// request (lib/audio-lite.js). It is a device setting, like volume: the phone
// on mobile data wants it, the desktop on home internet does not.
export const DATA_SAVER_FORMATS = [
  { variant: 'opus', type: 'audio/webm; codecs="opus"', megabytesPerHour: 15 },
  { variant: 'mp3', type: 'audio/mpeg', megabytesPerHour: 22 },
];
export const DATA_SAVER_POLL_MS = 5000;
export const DATA_SAVER_MAX_BACKOFF_MS = 120000;
export const DATA_SAVER_RETRY_FAILED_MS = 10 * 60 * 1000;   // the server retries a failed copy after 10 minutes
const KEY = 'tvclone.audio.dataSaver', FAILED_KEY = 'tvclone.audio.dataSaver.failed';

// Storage throws in private windows and when site data is blocked.
export function rememberedDataSaver(storage = globalThis.localStorage) {
  try { return storage?.getItem(KEY) === 'on'; } catch { return false; }
}
export function rememberDataSaver(value, storage = globalThis.localStorage) {
  const on = !!value;
  try { storage?.setItem(KEY, on ? 'on' : 'off'); } catch { /* Storage may be disabled. */ }
  return on;
}
function failedFormats(storage) {
  try {
    const value = JSON.parse(storage?.getItem(FAILED_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
// The first format the browser says it can play that has not already failed
// here. canPlayType only says "maybe", so a format that then errors is skipped
// from then on, and the next one is tried.
export function dataSaverFormat(audio, storage = globalThis.localStorage) {
  const failed = failedFormats(storage);
  return DATA_SAVER_FORMATS.find(format => !failed.includes(format.variant) && audio?.canPlayType?.(format.type)) || null;
}
export function rememberDataSaverFailure(variant, storage = globalThis.localStorage) {
  const failed = failedFormats(storage);
  try { if (!failed.includes(variant)) storage?.setItem(FAILED_KEY, JSON.stringify([...failed, variant])); } catch { /* Storage may be disabled. */ }
}
// Turning data saver on again is the listener's way of saying "try again", so
// a format remembered as unplayable (perhaps after one bad download) is not
// ruled out on this device for good.
export function forgetDataSaverFailures(storage = globalThis.localStorage) {
  try { storage?.removeItem(FAILED_KEY); } catch { /* Storage may be disabled. */ }
}
export function dataSaverCopy(status, format) {
  return format && status?.state === 'ready' && typeof status.url === 'string' && /^\/stream\//.test(status.url)
    ? { url: status.url, type: format.type, variant: format.variant } : null;
}
export function originalMegabytesPerHour(item, duration) {
  return Number(item?.fileSize) > 0 && duration > 0 ? Math.round(item.fileSize / 1e6 / (duration / 3600)) : null;
}
// The media element reports a 404/502 or a dropped connection before any audio
// arrived with the same error code as a file it cannot decode. Fetching a
// small part of the copy tells them apart: if that arrives as audio, the
// download works and the browser really could not play it.
export async function copyDownloads(url, fetchFn = globalThis.fetch) {
  try {
    const response = await fetchFn(url, { headers: { Range: 'bytes=0-1023' }, cache: 'no-store', credentials: 'same-origin' });
    response.body?.cancel?.().catch?.(() => {});
    return (response.status === 206 || response.status === 200) && /^audio\//.test(response.headers.get('content-type') || '');
  } catch { return false; }
}

const NORMAL = 'Normal quality plays until it\'s ready.';
export function dataSaverMessage({ on, format, status, active = false, pending = false, original = null }) {
  if (!on) return '';
  if (!format) return 'This browser can\'t play the smaller formats, so normal quality is used.';
  if (active) return `Data saver on: about ${format.megabytesPerHour} MB an hour${original ? ` instead of ${original}` : ''}.`;
  switch (status?.state) {
    case 'preparing': return `Making a smaller copy of this book (${Math.round((status.progress || 0) * 100)}%). ${NORMAL}`;
    case 'queued': return `Waiting to make a smaller copy of this book. ${NORMAL}`;
    case 'failed': return `Data saver isn't available for this book right now${status.message ? `: ${status.message.replace(/\.$/, '')}` : ''}. Normal quality is playing.`;
    case 'ready': return pending ? 'The smaller copy is ready. It will be used when you next pause or come back to this screen.' : 'Switching to the smaller copy…';
    case 'unreachable': return 'Couldn\'t reach the server for data saver. Normal quality is playing.';
    case 'unplayable': return 'The smaller copy didn\'t play on this device, so normal quality is playing.';
    case 'retrying': return 'The smaller copy didn\'t download just now. Normal quality is playing; it will be tried again shortly.';
    default: return 'Checking for a smaller copy of this book…';
  }
}
