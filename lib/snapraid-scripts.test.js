// The SnapRAID scripts (scripts/snapraid/, docs/plans/2026-10-26-snapraid-plan.md), run without root:
// the configuration the setup would write, and the nightly job against a pretend snapraid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'scripts', 'snapraid');

test('the configuration puts parity on the chosen drive, keeps three file lists on other disks, and leaves downloads out', () => {
  const conf = execFileSync('bash', [path.join(dir, 'setup-snapraid.sh'), '--print-config', '/media/blue/Media6TB'], { encoding: 'utf8' });
  assert.match(conf, /^parity \/media\/blue\/Media6TB\/snapraid\.parity$/m);
  assert.equal((conf.match(/^content /gm) || []).length, 3);
  assert.ok(!conf.includes('content /media/blue/Media6TB'), 'no file list on the parity drive');
  // SnapRAID takes the rest of the line as the path, spaces included; quotes become part of the name
  // (the first live run failed with: Error accessing 'content' dir '"/media/blue/New Volume/').
  assert.ok(!conf.includes('"'), 'no quotes anywhere in the configuration');
  assert.match(conf, /^content \/media\/blue\/New Volume\/snapraid\.content$/m);
  for (const d of ['d1 /media/blue/OOS6000G USB Device/', 'd2 /media/blue/New Volume/', 'd3 /media/blue/ST2000DM 008-2FR102 USB Device/']) {
    assert.ok(conf.includes(`data ${d}\n`), d);
  }
  assert.ok(!/^data d4/m.test(conf), 'the parity drive is not a data drive');
  for (const ex of ['/Share/', '/incomplete/', '/.incoming/', '*.tmp', '/$RECYCLE.BIN/', '/snapraid.content']) assert.ok(conf.includes(`exclude ${ex}`), ex);
});

// The real snapraid, when installed, must accept a configuration written the same way (paths with
// spaces, no quotes). Two content files on different filesystems, as snapraid demands.
test('snapraid itself parses paths with spaces written the way the setup writes them', { skip: !fs.existsSync('/usr/bin/snapraid') && 'snapraid not installed' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr conf-'));
  const shm = fs.mkdtempSync('/dev/shm/sr conf-');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(shm, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'data one', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data one', 'x', 'a.txt'), 'hi');
  fs.writeFileSync(path.join(root, 'conf'), [
    `parity ${root}/par ity/snapraid.parity`, `content ${root}/snapraid.content`, `content ${shm}/snapraid.content`,
    `data d1 ${root}/data one/`, 'exclude *.tmp', '',
  ].join('\n'));
  const r = spawnSync('/usr/bin/snapraid', ['-c', path.join(root, 'conf'), 'diff'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr); // 2 = there are changes to sync; 1 would be a configuration error
  assert.doesNotMatch(r.stdout + r.stderr, /Error accessing/);
});

test('the parity drive is taken out of the pool line in fstab, wherever it sits in the list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fstab-'));
  const file = path.join(root, 'fstab');
  const line = branches => `${branches} /mnt/media mergerfs defaults,allow_other,category.create=epmfs,minfreespace=10G 0 0`;
  const nv = '/media/blue/New\\040Volume', oos = '/media/blue/OOS6000G\\040USB\\040Device';
  for (const [before, after] of [[`${oos}:${nv}:/media/blue/Media6TB`, `${oos}:${nv}`], [`/media/blue/Media6TB:${nv}`, nv], [nv, nv]]) {
    fs.writeFileSync(file, `UUID=x /boot ext4 defaults 0 2\n${line(before)}\n`);
    execFileSync('bash', [path.join(dir, 'setup-snapraid.sh'), '--drop-from-pool', '/media/blue/Media6TB', file]);
    assert.equal(fs.readFileSync(file, 'utf8'), `UUID=x /boot ext4 defaults 0 2\n${line(after)}\n`, before);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// A pretend snapraid: "diff" prints a summary with N removed and exits 2 (changes) or 0; sync/scrub are recorded.
function pretend(t, { removed = 0, changes = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapraid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = path.join(root, 'calls');
  const bin = path.join(root, 'snapraid');
  // "sync" keeps a copy of the receipt as it stood while the sync ran.
  fs.writeFileSync(bin, `#!/bin/bash\nshift 2\necho "$1" >> '${calls}'\nif [ "$1" = diff ]; then printf ' 100 equal\\n 2 added\\n %s removed\\n 0 updated\\n' ${removed}; exit ${changes ? 2 : 0}; fi\nif [ "$1" = sync ]; then cp '${root}/receipt.json' '${root}/receipt.at-sync-start' 2>/dev/null; fi\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'snapraid.conf'), 'parity /x\n');
  const run = (...args) => spawnSync('bash', [path.join(dir, 'snapraid-nightly.sh'), ...args], { encoding: 'utf8', env: {
    ...process.env, SNAPRAID_BIN: bin, SNAPRAID_CONF: path.join(root, 'snapraid.conf'), SNAPRAID_RECEIPT: path.join(root, 'receipt.json'),
    SNAPRAID_LOG: path.join(root, 'log'), SNAPRAID_DELETE_LIMIT: '200', SNAPRAID_SUNDAY: process.env.FAKE_SUNDAY || '0',
  } });
  const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
  const receipt = (name = 'receipt.json') => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
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

// The first sync takes a day or more; without this the Dashboard and the bell would go on showing the
// previous run (a failure, on the first live attempt) the whole time.
test('while a sync runs, the receipt already says so instead of repeating the previous run', t => {
  const p = pretend(t, { removed: 3 });
  assert.equal(p.run().status, 0);
  const during = p.receipt('receipt.at-sync-start');
  assert.equal(during.result, 'syncing'); assert.equal(during.ok, true); assert.equal(during.deleted, 3);
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
