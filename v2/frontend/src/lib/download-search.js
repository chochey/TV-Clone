// Each search owns its ID and callbacks, including after page teardown.
export function createDownloadSearch(api, update, timers = globalThis, now = Date.now) {
  let generation = 0, active = null, timer;
  const stopId = id => Promise.resolve(api.searchStop(id)).catch(() => {});
  function stop() {
    generation++;
    timers.clearTimeout(timer);
    if (active != null) stopId(active);
    active = null;
    update({ searching: false });
  }
  async function start(query, category, plugin) {
    stop();
    const mine = generation;
    const current = () => generation === mine;
    update({ searching: true, results: null, error: '', total: 0, note: '' });
    let id, deadline, failures = 0;
    const found = new Map();
    try {
      const reply = await api.searchStart(query, category, plugin);
      id = reply.id;
      if (id == null) throw new Error('Search could not start. Check that search plugins are installed.');
      if (!current()) { stopId(id); return; }
      active = id;
      deadline = now() + 90000;
    } catch (error) {
      if (current()) update({ searching: false, error: error.body?.error || error.message || 'Search failed.' });
      return;
    }
    async function poll() {
      if (!current()) return;
      try {
        let offset = 0, total = 0, status = 'Stopped';
        const max = 2000, pageSize = 200;
        do {
          const reply = await api.searchResults(id, pageSize, offset);
          if (!current()) return;
          if (!Array.isArray(reply.results)) throw new Error('Search returned an invalid response.');
          total = Number(reply.total) || reply.results.length;
          status = reply.status;
          for (const row of reply.results) {
            if (row.fileUrl) found.set(row.fileUrl, row);
          }
          offset += reply.results.length;
          update({ results: [...found.values()], total, error: '' });
          if (!reply.results.length || now() >= deadline) break;
        } while (offset < total && offset < max);
        failures = 0;
        if (status === 'Running' && now() < deadline) {
          timer = timers.setTimeout(poll, 2000);
        } else {
          update({ note: now() >= deadline ? 'Search time limit reached; showing results received.'
            : total > max ? `Loaded the first ${max} results. Narrow your search to see more.` : '' });
          stop();
        }
      } catch (error) {
        if (!current()) return;
        failures++;
        update({ error: error.body?.error || error.message || 'Search connection lost. Results received are kept.' });
        if (failures < 3 && now() < deadline) timer = timers.setTimeout(poll, 2000 * failures);
        else stop();
      }
    }
    await poll();
  }
  return { start, stop };
}
