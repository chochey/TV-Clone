// Sequential, visibility-aware polling. A late response cannot publish or
// create a timer after teardown; a refresh requested in flight runs next.
export function createRefreshLoop({ load, onData, onError = () => {}, interval = () => 0,
  documentTarget = globalThis.document, timers = globalThis }) {
  let stopped = false, running = null, queued = false, timer, version = 0;
  const visible = () => !documentTarget || documentTarget.visibilityState !== 'hidden';
  function schedule() {
    timers.clearTimeout(timer);
    const delay = interval();
    if (!stopped && !running && visible() && delay > 0) timer = timers.setTimeout(refresh, delay);
  }
  function refresh() {
    if (stopped) return Promise.resolve();
    timers.clearTimeout(timer);
    version++;
    if (!visible()) return Promise.resolve();
    if (running) { queued = true; return running; }
    const requested = version;
    running = Promise.resolve().then(load).then(data => {
      if (!stopped && requested === version) onData(data);
    }).catch(error => {
      if (!stopped && requested === version) onError(error);
    }).finally(() => {
      running = null;
      if (stopped) return;
      if (queued) { queued = false; refresh(); } else schedule();
    });
    return running;
  }
  function onVisibility() { if (visible()) refresh(); else timers.clearTimeout(timer); }
  documentTarget?.addEventListener('visibilitychange', onVisibility);
  return { refresh, schedule, invalidate() { version++; }, stop() {
    stopped = true; version++; queued = false; timers.clearTimeout(timer);
    documentTarget?.removeEventListener('visibilitychange', onVisibility);
  } };
}
