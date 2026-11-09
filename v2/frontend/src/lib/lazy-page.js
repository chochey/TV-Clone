// A page that will not load is nearly always a tab opened before the last deploy: the new build replaced the
// page's file. Reloading picks up the new build. At most once a minute, so a page that is really missing shows
// its error instead of reloading forever; and never when the browser cannot remember the reload.
const KEY = 'v2LazyPageReloadAt';

export function reloadOnceForMissingPage(storage, now = Date.now()) {
  try {
    const last = Number(storage.getItem(KEY)) || 0;
    if (last && now - last < 60000) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch { return false; }
}
