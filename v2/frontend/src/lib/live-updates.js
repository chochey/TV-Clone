// One lifecycle per signed-in profile. All callbacks are invalid after stop().
export function startLiveUpdates({ refreshLibrary, refreshNotifications,
  EventSourceClass = globalThis.EventSource, documentTarget = globalThis.document,
  timers = globalThis }) {
  if (!EventSourceClass) return () => {};
  const es = new EventSourceClass('/api/events');
  let stopped = false, firstOpen = true, refreshTimer, notifTimer;
  const run = fn => { if (!stopped) Promise.resolve().then(() => { if (!stopped) return fn(); }).catch(() => {}); };
  const refetch = delay => {
    timers.clearTimeout(refreshTimer);
    refreshTimer = timers.setTimeout(() => run(refreshLibrary), delay);
  };
  const notifs = delay => {
    timers.clearTimeout(notifTimer);
    notifTimer = timers.setTimeout(() => run(refreshNotifications), delay);
  };
  es.addEventListener('library-updated', () => { if (!stopped) refetch(2000); });
  es.addEventListener('notifications-updated', () => { if (!stopped) notifs(500); });
  es.addEventListener('open', () => {
    if (stopped) return;
    if (firstOpen) { firstOpen = false; return; }
    refetch(500); notifs(500);
  });
  const refresh = () => { run(refreshLibrary); run(refreshNotifications); };
  const heartbeat = timers.setInterval(refresh, 5 * 60 * 1000);
  const onVisible = () => { if (documentTarget.visibilityState === 'visible') refresh(); };
  documentTarget.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    es.close();
    timers.clearTimeout(refreshTimer);
    timers.clearTimeout(notifTimer);
    timers.clearInterval(heartbeat);
    documentTarget.removeEventListener('visibilitychange', onVisible);
  };
}
