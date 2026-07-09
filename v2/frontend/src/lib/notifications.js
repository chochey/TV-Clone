// App-wide notification center, backed by the server's notification history
// (/api/notifications). The server generates events at the source — library
// scans, its own download watcher, organizer failures — so every device sees
// the same list and nothing is missed while no tab is open. Only the
// read/cleared cursors live in this browser.
import { writable, derived } from 'svelte/store';
import { api } from './api.js';

const READ_KEY = 'v2NotifLastRead';   // newest id this device has marked read
const CLEAR_KEY = 'v2NotifCleared';   // ids <= this are hidden on this device

const cursor = (key) => parseInt(localStorage.getItem(key) || '0', 10) || 0;

export const notifications = writable([]); // newest first
export const unreadCount = derived(notifications, ($n) => $n.filter((x) => !x.read).length);

// Master gate, driven by the canNotify permission.
let enabled = true;
export function setNotificationsEnabled(v) {
  enabled = !!v;
  if (!enabled) notifications.set([]);
}

export async function loadNotifications() {
  if (!enabled) return;
  let list;
  try { list = (await api.notifications()).notifications || []; } catch { return; }
  const read = cursor(READ_KEY);
  const cleared = cursor(CLEAR_KEY);
  notifications.set(
    list.filter((n) => n.id > cleared).map((n) => ({ ...n, read: n.id <= read })),
  );
}

export function markAllRead() {
  notifications.update((list) => {
    if (list[0]) try { localStorage.setItem(READ_KEY, String(list[0].id)); } catch {}
    return list.map((x) => ({ ...x, read: true }));
  });
}

export function clearNotifications() {
  notifications.update((list) => {
    if (list[0]) {
      try {
        localStorage.setItem(CLEAR_KEY, String(list[0].id));
        localStorage.setItem(READ_KEY, String(list[0].id));
      } catch {}
    }
    return [];
  });
}
