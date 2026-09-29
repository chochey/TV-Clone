export function createSpriteLoader({ id, onData, preload, isCurrent = () => true, fetcher = fetch, timers = globalThis }) {
  let active = true, timer, preloaded = false;
  const current = () => active && isCurrent();
  async function load() {
    if (!current()) return;
    try {
      const response = await fetcher(`/api/sprites/${encodeURIComponent(id)}/generate`, { method: 'POST', credentials: 'same-origin' });
      if (!current() || !response.ok) return;
      const data = await response.json();
      if (!current()) return;
      onData(data);
      if (data.totalSheets > 0 && (!preloaded || data.status === 'ready')) {
        preloaded = true;
        preload(data);
      }
      if (data.status !== 'ready') timer = timers.setTimeout(load, 5000);
    } catch {}
  }
  return { load, stop() { active = false; timers.clearTimeout(timer); } };
}
