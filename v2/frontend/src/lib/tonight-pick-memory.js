// What this device remembers about Tonight's pick: which films were skipped with "Another" (and
// when), and which film was the pick on which day. Per device, in localStorage; absent or
// unreadable storage just means no memory.
const KEY = 'v2TonightPick';
const EMPTY = { skipped: {}, shown: [] };

export function loadPickMemory(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    return { skipped: parsed.skipped && typeof parsed.skipped === 'object' ? parsed.skipped : {}, shown: Array.isArray(parsed.shown) ? parsed.shown : [] };
  } catch { return { ...EMPTY }; }
}

export function savePickMemory(memory, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(memory)); } catch { /* private window, full, or blocked: the pick just will not be remembered */ }
}

// One entry per day, newest last, the last 30 days kept.
export function rememberShown(memory, day, id) {
  const shown = memory.shown.filter(s => s.day !== day).concat({ day, id }).slice(-30);
  return { ...memory, shown };
}

// Skips older than a month are of no further use and are dropped while adding the new one.
export function rememberSkipped(memory, id, day) {
  const keep = Object.entries(memory.skipped).filter(([, on]) => Date.parse(`${day}T12:00:00`) - Date.parse(`${on}T12:00:00`) < 30 * 86400000);
  return { ...memory, skipped: { ...Object.fromEntries(keep), [id]: day } };
}
