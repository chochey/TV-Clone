// JSON persistence primitives used across the server. Pure functions.
const fs = require('fs');
const writeQueues = new Map();

function loadJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { /* corrupt file */ }
  return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
}

// Async atomic write of pre-serialized content: temp file + rename.
// Writes to the same path are queued so concurrent saves can't interleave.
function saveRaw(filePath, content) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, content);
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      console.error('[saveJSON] Write error:', filePath, err.message);
      try { await fs.promises.unlink(tmpPath); } catch {}
    }
  }).finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  });
  writeQueues.set(filePath, next);
}

// Async atomic write: temp file + rename. Non-blocking, safe on crash.
function saveJSON(filePath, data) {
  saveRaw(filePath, JSON.stringify(data, null, 2));
}

// Sync write — for startup/migration paths where order matters.
function saveJSONSync(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = { loadJSON, saveJSON, saveJSONSync, saveRaw };
