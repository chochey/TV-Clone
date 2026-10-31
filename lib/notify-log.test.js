const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createNotifyLog = require('./notify-log');

function log(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  return createNotifyLog({ DATA_DIR: dir, loadJSON, saveJSON: (f, v) => fs.writeFileSync(f, JSON.stringify(v)) });
}

test('new-episode alerts, old ones included, go to New episodes holders; downloads stay with Downloads', t => {
  const n = log(t);
  n.push({ type: 'episode', title: 'old alert', audience: 'download' });   // written before the split
  n.push({ type: 'episode', title: 'new alert', audience: 'episodes' });
  n.push({ type: 'complete', title: 'download done', audience: 'download' });
  n.push({ type: 'added', title: 'for everyone' });
  const titles = permissions => n.list({ role: 'user', permissions }).map(e => e.title);
  assert.deepEqual(titles(['canEpisodes']), ['for everyone', 'new alert', 'old alert']);
  assert.deepEqual(titles(['canDownload']), ['for everyone', 'download done']);
  assert.deepEqual(titles([]), ['for everyone']);
  assert.equal(n.list({ role: 'admin' }).length, 4);
});
