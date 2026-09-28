const path = require('path');
const SAFE = new Set(['uploading','stalledUP','pausedUP','stoppedUP','queuedUP','forcedUP']);
function downloadReadiness(torrents, now = Date.now()) {
  return {updatedAt:now, entries:torrents.map(t => ({
    names:[t.name,path.posix.basename(t.content_path || '')].filter(Boolean),
    ready:t.progress >= 1 && SAFE.has(t.state), state:t.state,
  }))};
}
module.exports = {downloadReadiness};
