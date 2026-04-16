// JSON persistence primitives used across the server. Pure functions.
const fs = require('fs');

function loadJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { /* corrupt file */ }
  return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
}

// Async atomic write: temp file + rename. Non-blocking, safe on crash.
function saveJSON(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  const tmpPath = filePath + '.tmp';
  fs.writeFile(tmpPath, content, (err) => {
    if (err) { console.error('[saveJSON] Write error:', filePath, err.message); return; }
    fs.rename(tmpPath, filePath, (err2) => {
      if (err2) console.error('[saveJSON] Rename error:', filePath, err2.message);
    });
  });
}

// Sync write — for startup/migration paths where order matters.
function saveJSONSync(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = { loadJSON, saveJSON, saveJSONSync };
