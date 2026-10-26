// The backup, watchdog and boot-repair jobs run as root. They used to run the live checkout, which the
// user's own account can write; scripts/install-root-copy.js puts a root-owned copy of exactly the
// files they need elsewhere and points the units at it. Tested here into a temporary prefix, no root.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { filesNeeded, install, check } = require('../scripts/install-root-copy');

const repo = path.join(__dirname, '..');
const script = path.join(repo, 'scripts', 'install-root-copy.js');

test('the files needed are the reliability script and the modules it reaches, no tests', () => {
  const files = filesNeeded(repo);
  for (const f of ['scripts/tvclone-reliability.js', 'lib/reliability.js', 'lib/verified-backup.js', 'lib/backup-encrypted-copy.js']) assert.ok(files.includes(f), f);
  assert.ok(files.every(f => !f.endsWith('.test.js')));
  assert.ok(files.every(f => fs.existsSync(path.join(repo, f))));
});

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { prefix: path.join(dir, 'libexec'), unitsDir: path.join(dir, 'units') };
}

test('install copies the files read-only to the prefix and points the three units at the copy, the watchdog as a quiet loop', t => {
  const { prefix, unitsDir } = tmp(t);
  const report = install({ repo, prefix, unitsDir, systemctl: false });
  assert.ok(report.copied.length >= 5);
  const copied = path.join(prefix, 'app', 'lib', 'reliability.js');
  assert.equal(fs.readFileSync(copied, 'utf8'), fs.readFileSync(path.join(repo, 'lib', 'reliability.js'), 'utf8'));
  assert.equal(fs.statSync(copied).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(prefix, 'app', 'scripts', 'tvclone-reliability.js')).mode & 0o777, 0o755);
  const dropin = name => fs.readFileSync(path.join(unitsDir, `${name}.service.d`, 'root-copy.conf'), 'utf8');
  assert.match(dropin('tvclone-backup'), new RegExp(`ExecStart=\\n\\s*ExecStart=/usr/bin/node ${prefix}/app/scripts/tvclone-reliability.js backup --repo /srv/chocheytv/app`));
  assert.match(dropin('tvclone-boot-repair'), /tvclone-reliability\.js boot-repair --repo \/srv\/chocheytv\/app/);
  const watchdog = dropin('tvclone-watchdog');
  assert.match(watchdog, /Type=simple/); assert.match(watchdog, /Restart=always/);
  assert.match(watchdog, /tvclone-reliability\.js watchdog --loop 60 --repo \/srv\/chocheytv\/app/);
  assert.match(watchdog, /\[Install\]\nWantedBy=multi-user\.target/);
  for (const d of ['tvclone-backup', 'tvclone-boot-repair', 'tvclone-watchdog']) assert.match(dropin(d), new RegExp(`WorkingDirectory=${prefix}/app`));
});

test('check says when the copy matches, and names what is stale or missing', t => {
  const { prefix, unitsDir } = tmp(t);
  assert.deepEqual(check({ repo, prefix }).stale.length > 0, true, 'nothing installed yet: everything is missing');
  install({ repo, prefix, unitsDir, systemctl: false });
  assert.deepEqual(check({ repo, prefix }), { ok: true, stale: [] });
  fs.appendFileSync(path.join(prefix, 'app', 'lib', 'verified-backup.js'), '\n// old\n');
  const r = check({ repo, prefix });
  assert.equal(r.ok, false); assert.deepEqual(r.stale, ['lib/verified-backup.js']);
  // The command line: exit 0 when current, 1 when not.
  const stale = spawnSync('node', [script, '--check', '--repo', repo, '--prefix', prefix], { encoding: 'utf8' });
  assert.equal(stale.status, 1); assert.match(stale.stdout + stale.stderr, /verified-backup\.js/);
  install({ repo, prefix, unitsDir, systemctl: false });
  assert.equal(execFileSync('node', [script, '--check', '--repo', repo, '--prefix', prefix], { encoding: 'utf8' }).trim(), 'Root-run jobs use a current copy.');
});
