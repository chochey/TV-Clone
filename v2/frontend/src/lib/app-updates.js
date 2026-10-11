export function loadedAppVersion(document) {
  const assets = new Set();
  for (const element of document?.querySelectorAll?.('script[type="module"][src],link[rel="stylesheet"][href]') || []) {
    try {
      const pathname = new URL(element.src || element.href, document.baseURI).pathname;
      const match = pathname.match(/\/assets\/([^/]+\.(?:js|css))$/);
      if (match) assets.add(match[1]);
    } catch {}
  }
  return [...assets].sort().join('|');
}

export const canRefreshApp = (available, playerOpen) => !!available && !playerOpen;

export function createAppUpdateMonitor({ load, initialVersion = '', onUpdate = () => {} }) {
  let baseline = initialVersion, pending = false, stopped = false;
  async function check() {
    if (pending || stopped) return;
    pending = true;
    try {
      const result = await load();
      if (stopped || typeof result?.version !== 'string' || !result.version) return;
      if (!baseline) baseline = result.version;
      else onUpdate(result.version !== baseline);
    } catch { /* transient outages do not replace the loaded build baseline */ }
    finally { pending = false; }
  }
  return { check, stop() { stopped = true; } };
}
