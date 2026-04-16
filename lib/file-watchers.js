// Recursive fs.watch on configured library folders. Debounced, non-persistent.
const fs = require('fs');
const path = require('path');

module.exports = function createWatchers({ getFolders, supportedExt, debounceMs, onChange }) {
  let watchers = [];

  function setup() {
    watchers.forEach(w => { try { w.close(); } catch {} });
    watchers = [];

    for (const folder of getFolders()) {
      if (!fs.existsSync(folder.path)) continue;
      try {
        const watcher = fs.watch(folder.path, { persistent: false, recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const ext = path.extname(filename).toLowerCase();
          if (!supportedExt.includes(ext)) return;
          clearTimeout(watcher._debounce);
          watcher._debounce = setTimeout(onChange, debounceMs);
        });
        watchers.push(watcher);
      } catch { /* can't watch this folder */ }
    }
  }

  return { setup, close: () => { watchers.forEach(w => { try { w.close(); } catch {} }); watchers = []; } };
};
