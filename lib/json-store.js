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
function enqueueRaw(filePath, content, durable) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      if (durable) {
        const handle = await fs.promises.open(tmpPath, 'w');
        try { await handle.writeFile(content); await handle.sync(); }
        finally { await handle.close(); }
      } else await fs.promises.writeFile(tmpPath, content);
      await fs.promises.rename(tmpPath, filePath);
      if (durable) {
        const dir = await fs.promises.open(require('path').dirname(filePath), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } catch (err) {
      try { await fs.promises.unlink(tmpPath); } catch {}
      throw err;
    }
  }).finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
  });
  writeQueues.set(filePath, next);
  return next;
}

// Ordinary background writes retain their existing best-effort behavior.
// Destructive workflows use the strict variant and await durable completion.
function saveRaw(filePath, content) {
  return enqueueRaw(filePath, content, false).catch(err => {
    console.error('[saveJSON] Write error:', filePath, err.message);
  });
}

function saveRawStrict(filePath, content) { return enqueueRaw(filePath, content, true); }

// Async atomic write: temp file + rename. Non-blocking, safe on crash.
function saveJSON(filePath, data) {
  return saveRaw(filePath, JSON.stringify(data, null, 2));
}

function saveJSONStrict(filePath, data) {
  return saveRawStrict(filePath, JSON.stringify(data, null, 2));
}

// Sync write — for startup/migration paths where order matters.
function saveJSONSync(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = { loadJSON, saveJSON, saveJSONStrict, saveJSONSync, saveRaw, saveRawStrict };
