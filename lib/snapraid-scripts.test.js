// The SnapRAID scripts (scripts/snapraid/, docs/plans/2026-10-26-snapraid-plan.md), run without root:
// the configuration the setup would write, and the nightly job against a pretend snapraid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'scripts', 'snapraid');

test('the configuration puts parity on the new drive, keeps three file lists, and leaves downloads out', () => {
  const conf = execFileSync('bash', [path.join(dir, 'setup-snapraid.sh'), '--print-config'], { encoding: 'utf8' });
  assert.match(conf, /^parity \/media\/blue\/Parity1\/snapraid\.parity$/m);
  assert.equal((conf.match(/^content /gm) || []).length, 3);
  for (const d of ['d1 "/media/blue/OOS6000G USB Device/"', 'd2 "/media/blue/New Volume/"', 'd3 "/media/blue/ST2000DM 008-2FR102 USB Device/"', 'd4 /media/blue/Media6TB/']) {
    assert.ok(conf.includes(`data ${d}`), d);
  }
  for (const ex of ['/Share/', '/incomplete/', '/.incoming/', '*.tmp', '/$RECYCLE.BIN/', '/snapraid.content']) assert.ok(conf.includes(`exclude ${ex}`), ex);
});

// A pretend snapraid: "diff" prints a summary with N removed and exits 2 (changes) or 0; sync/scrub are recorded.
function pretend(t, { removed = 0, changes = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapraid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = path.join(root, 'calls');
  const bin = path.join(root, 'snapraid');
  fs.writeFileSync(bin, `#!/bin/bash\nshift 2\necho "$1" >> '${calls}'\nif [ "$1" = diff ]; then printf ' 100 equal\\n 2 added\\n %s removed\\n 0 updated\\n' ${removed}; exit ${changes ? 2 : 0}; fi\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'snapraid.conf'), 'parity /x\n');
  const run = (...args) => spawnSync('bash', [path.join(dir, 'snapraid-nightly.sh'), ...args], { encoding: 'utf8', env: {
    ...process.env, SNAPRAID_BIN: bin, SNAPRAID_CONF: path.join(root, 'snapraid.conf'), SNAPRAID_RECEIPT: path.join(root, 'receipt.json'),
    SNAPRAID_LOG: path.join(root, 'log'), SNAPRAID_DELETE_LIMIT: '200', SNAPRAID_SUNDAY: process.env.FAKE_SUNDAY || '0',
  } });
  const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
  const receipt = () => JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'), 'utf8'));
  return { run, called, receipt };
}

test('the nightly job syncs when files changed, and says so in its receipt', t => {
  const p = pretend(t, { removed: 3 });
  const r = p.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(p.called(), ['diff', 'sync']);
  const receipt = p.receipt();
  assert.equal(receipt.result, 'synced'); assert.equal(receipt.ok, true); assert.equal(receipt.deleted, 3); assert.equal(receipt.scrubbed, false);
});

test('too many vanished files stop the sync, so a mistaken mass delete can still be undone; --force goes ahead', t => {
  const p = pretend(t, { removed: 450 });
  const r = p.run();
  assert.equal(r.status, 2);
  assert.match(r.stdout, /450 files vanished/);
  assert.deepEqual(p.called(), ['diff']);
  assert.deepEqual([p.receipt().result, p.receipt().error, p.receipt().ok], ['refused', 'TOO_MANY_DELETED', false]);
  const forced = pretend(t, { removed: 450 });
  assert.equal(forced.run('--force').status, 0);
  assert.deepEqual(forced.called(), ['diff', 'sync']);
});

test('nothing to do is fine, and Sundays also scrub', t => {
  const p = pretend(t, { changes: false });
  assert.equal(p.run().status, 0);
  assert.deepEqual(p.called(), ['diff']);
  assert.equal(p.receipt().result, 'nothing-to-do');
  process.env.FAKE_SUNDAY = '1';
  t.after(() => { delete process.env.FAKE_SUNDAY; });
  const sunday = pretend(t, { changes: false });
  assert.equal(sunday.run().status, 0);
  assert.deepEqual(sunday.called(), ['diff', 'scrub']);
  assert.equal(sunday.receipt().scrubbed, true);
});
