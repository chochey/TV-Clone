export const AUDIO_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
export const rememberedAudioSpeed = value => AUDIO_SPEEDS.includes(Number(value)) ? Number(value) : 1;

// Volume stays on the device, like the video player's, because the level that
// suits desktop speakers is wrong for phone headphones -- unlike speed, which
// is a travelling preference stored per profile on the server. Returns null for
// anything unusable so callers fall back to full volume: getItem yields null for
// an unset key, and Number(null) is 0, which would start new listeners silent.
const VOLUME_KEY = 'tvclone.audio.volume';
export function audioVolumeInRange(value) {
  if (value === null || value === undefined || value === '') return null;
  const volume = Number(value);
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : null;
}
export function rememberedAudioVolume(storage = globalThis.localStorage) {
  // Storage throws in private windows and when site data is blocked.
  try { return audioVolumeInRange(storage?.getItem(VOLUME_KEY)) ?? 1; } catch { return 1; }
}
export function rememberAudioVolume(value, storage = globalThis.localStorage) {
  const volume = audioVolumeInRange(value) ?? 1;
  try { storage?.setItem(VOLUME_KEY, String(volume)); } catch { /* Storage may be disabled. */ }
  return volume;
}

export function audioBookmarks(value) {
  const bookmarks = Array.isArray(value?.bookmarks) ? value.bookmarks : [];
  return bookmarks.filter(bookmark => typeof bookmark?.id === 'string' && Number.isFinite(bookmark.time) && bookmark.time >= 0)
    .map(bookmark => ({ ...bookmark, label: typeof bookmark.label === 'string' ? bookmark.label : '' }))
    .sort((a, b) => a.time - b.time || (a.createdAt || 0) - (b.createdAt || 0));
}

// Minutes count elapsed time; chapter timers follow the audio position.
// Both use the same mounted player, including while it is minimized.
export function createSleepTimer({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onChange = () => {}, onExpire = () => {} } = {}) {
  let timer, plan = null;
  function clear() { clearTimer(timer); timer = undefined; plan = null; onChange(null); }
  function expire() {
    if (!plan) return;
    const finished = plan;
    clear(); onExpire(finished);
  }
  function set(mode, chapterEnd) {
    clear();
    if (mode === 'chapter' && Number.isFinite(chapterEnd) && chapterEnd > 0) plan = { mode, end: chapterEnd };
    else if ([15, 30, 60].includes(Number(mode))) {
      const milliseconds = Number(mode) * 60000;
      plan = { mode: String(mode), deadline: now() + milliseconds };
      const expected = plan;
      timer = setTimer(() => { if (plan === expected) expire(); }, milliseconds);
    }
    onChange(plan);
    return plan;
  }
  function position(time) {
    if (plan && (plan.mode === 'chapter' ? time >= plan.end : now() >= plan.deadline)) expire();
  }
  return { set, position, clear, destroy() { clearTimer(timer); timer = undefined; plan = null; } };
}
