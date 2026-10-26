// How fast this server converts 4K HEVC 10-bit video the way the player does it, measured once by
// ~/benchmark-4k.sh and kept as data/4k-benchmark.json. 1.0 = real time; below that, playback
// pauses while the server catches up. The title page uses it to warn before someone presses play.
const fs = require('fs');
const path = require('path');

module.exports = function createFourK({ dataDir }) {
  const file = path.join(dataDir, '4k-benchmark.json');
  let mtime = null, value = null;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  function speed() {
    let stat;
    try { stat = fs.statSync(file); } catch { mtime = null; return (value = null); }
    if (stat.mtimeMs === mtime) return value;
    mtime = stat.mtimeMs;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      value = { to1080p: num(raw.hevc10bitTo1080p), dataSaver: num(raw.hevc10bitDataSaver), measuredAt: num(raw.measuredAt) };
    } catch { value = null; }
    return value;
  }
  return { speed };
};
