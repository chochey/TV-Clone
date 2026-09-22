import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { startLiveUpdates } from './live-updates.js';
import { api } from './api.js';
import { session, library, libraryLoaded, dismissed, loadLibrary, resetSessionState } from './stores.js';
import { notifications, loadNotifications, setNotificationsEnabled } from './notifications.js';
class Events {
  static instances = [];
  handlers = new Map(); closed = false;
  constructor() { Events.instances.push(this); }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  close() { this.closed = true; }
  emit(name) { this.handlers.get(name)?.(); }
}
const doc = { visibilityState: 'visible', listeners: new Set(), addEventListener(_, f) { this.listeners.add(f); }, removeEventListener(_, f) { this.listeners.delete(f); } };
globalThis.EventSource = Events;
globalThis.document = doc;
globalThis.localStorage = { getItem() { return null; } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('live update teardown cancels timers, closes stream and removes visibility listener', async () => {
  const jobs = new Map(); let id = 0, calls = 0;
  const timers = { setTimeout(fn) { jobs.set(++id, fn); return id; }, clearTimeout(i) { jobs.delete(i); }, setInterval(fn) { jobs.set(++id, fn); return id; }, clearInterval(i) { jobs.delete(i); } };
  const stop = startLiveUpdates({ refreshLibrary() { calls++; }, refreshNotifications() { calls++; }, EventSourceClass: Events, documentTarget: doc, timers });
  const es = Events.instances.at(-1);
  es.emit('library-updated'); es.emit('notifications-updated');
  const lateCallbacks = [...jobs.values(), ...doc.listeners];
  stop();
  assert.equal(es.closed, true); assert.equal(jobs.size, 0); assert.equal(doc.listeners.size, 0);
  lateCallbacks.forEach(fn => fn()); es.emit('open'); es.emit('library-updated'); await flush();
  assert.equal(calls, 0); assert.equal(jobs.size, 0);
});

test('switching profiles rejects in-flight library, dismissals and notifications', async () => {
  const old = deferred(), oldDismissed = deferred(), oldNotifs = deferred();
  const requests = [];
  api.library = ({ profile }) => { requests.push(profile); return profile === 'a' ? old.promise : Promise.resolve([{ id: 'b-film' }]); };
  api.dismissed = () => oldDismissed.promise;
  api.notifications = () => oldNotifs.promise;
  try {
    session.set({ profileId: 'a' }); setNotificationsEnabled(true);
    const pending = loadLibrary('a'); const notices = loadNotifications();
    session.set(null); session.set({ profileId: 'b' });
    await loadLibrary('b');
    const bStream = Events.instances.at(-1);
    old.resolve([{ id: 'a-film' }]); oldNotifs.resolve({ notifications: [{ id: 9, title: 'private' }] });
    await pending; await notices;
    assert.deepEqual(get(library), [{ id: 'b-film' }]); assert.deepEqual(get(notifications), []);
    session.set(null); oldDismissed.resolve({ continueWatching: { secret: true } }); await flush();
    assert.deepEqual(get(dismissed), { continueWatching: {}, recentlyAdded: {} });
    assert.equal(get(libraryLoaded), false); assert.deepEqual(get(library), []); assert.equal(bStream.closed, true);
    await loadLibrary('a'); assert.deepEqual(requests, ['a', 'b']);
  } finally { session.set(null); resetSessionState(); }
});
