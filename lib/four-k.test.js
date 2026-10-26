// How fast this server converts 4K, measured once (~/benchmark-4k.sh) and kept in the data dir, so
// the title page can say honestly whether a 4K file will play smoothly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createFourK = require('./four-k');

test('reads the measurement, re-reads when the file changes, and says nothing when there is none', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fourk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fourK = createFourK({ dataDir: dir });
  assert.equal(fourK.speed(), null);
  const file = path.join(dir, '4k-benchmark.json');
  fs.writeFileSync(file, JSON.stringify({ measuredAt: 1, hevc10bitTo1080p: 0.62, hevc10bitDataSaver: 1.4 }));
  assert.deepEqual(fourK.speed(), { to1080p: 0.62, dataSaver: 1.4, measuredAt: 1 });
  fs.writeFileSync(file, JSON.stringify({ measuredAt: 2, hevc10bitTo1080p: 1.2, hevc10bitDataSaver: 2.1 }));
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(fourK.speed().to1080p, 1.2);
  fs.writeFileSync(file, 'not json');
  fs.utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  assert.equal(fourK.speed(), null);
});
