#!/usr/bin/env node
// The backup, watchdog and boot-repair jobs run as root. Until this, their units ran the live
// checkout (/srv/chocheytv/app), which the user's own account writes: anyone who got into that
// account could have had root at the next run. This puts a root-owned copy of exactly the files the
// reliability script reaches under /usr/local/libexec/tvclone/app and points the three units at it
// (drop-ins). The watchdog also becomes a quiet loop instead of a timer.
//
//   sudo node scripts/install-root-copy.js --repo /srv/chocheytv/app     install or refresh the copy
//   node scripts/install-root-copy.js --check --repo /srv/chocheytv/app   is the copy current? (deploy-live.sh asks)
//
// Re-run the install after a deploy that changes one of these files; the deploy says so.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ENTRY = 'scripts/tvclone-reliability.js';
const DEFAULT_PREFIX = '/usr/local/libexec/tvclone';
const DEFAULT_UNITS = '/etc/systemd/system';
const LIVE_REPO = '/srv/chocheytv/app';
const JOBS = [
  { unit: 'tvclone-backup', command: 'backup' },
  { unit: 'tvclone-boot-repair', command: 'boot-repair' },
  { unit: 'tvclone-watchdog', command: 'watchdog --loop 60', loop: true },
];

// The entry script and every module it requires, found by reading the files (relative paths).
function filesNeeded(repo) {
  const seen = new Set();
  const todo = [ENTRY];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) continue;
    seen.add(rel);
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\((?:'|")(\.[^'"]+)(?:'|")\)/g)) {
      let next = path.normalize(path.join(path.dirname(rel), m[1]));
      if (!/\.(js|json)$/.test(next) && fs.existsSync(path.join(repo, next + '.js'))) next += '.js';
      todo.push(next);
    }
  }
  return [...seen].sort();
}

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function check({ repo, prefix = DEFAULT_PREFIX }) {
  const stale = filesNeeded(repo).filter(rel => {
    const copy = path.join(prefix, 'app', rel);
    return !fs.existsSync(copy) || digest(copy) !== digest(path.join(repo, rel));
  });
  return { ok: stale.length === 0, stale };
}

function dropIn(prefix, job) {
  const exec = `/usr/bin/node ${prefix}/app/scripts/tvclone-reliability.js ${job.command} --repo ${LIVE_REPO}`;
  const lines = ['# Written by scripts/install-root-copy.js: run the root-owned copy, not the live checkout.', '[Service]',
    `WorkingDirectory=${prefix}/app`, 'ExecStart=', `ExecStart=${exec}`];
  if (job.loop) {
    // One quiet process instead of a timer firing every minute (lib/watchdog-quiet.js).
    lines.push('Type=simple', 'Restart=always', 'RestartSec=30', 'TimeoutStartSec=infinity', '', '[Install]', 'WantedBy=multi-user.target');
  }
  return lines.join('\n') + '\n';
}

function install({ repo, prefix = DEFAULT_PREFIX, unitsDir = DEFAULT_UNITS, systemctl = true, log = () => {} }) {
  const copied = [];
  for (const rel of filesNeeded(repo)) {
    const to = path.join(prefix, 'app', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(repo, rel), to);
    fs.chmodSync(to, rel === ENTRY ? 0o755 : 0o644);
    if (process.getuid && process.getuid() === 0) fs.chownSync(to, 0, 0);
    copied.push(rel);
  }
  for (const job of JOBS) {
    const dir = path.join(unitsDir, `${job.unit}.service.d`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'root-copy.conf'), dropIn(prefix, job), { mode: 0o644 });
  }
  if (systemctl) {
    const run = args => { log(`systemctl ${args.join(' ')}`); execFileSync('systemctl', args, { stdio: 'inherit' }); };
    run(['daemon-reload']);
    run(['disable', '--now', 'tvclone-watchdog.timer']);
    run(['enable', '--now', 'tvclone-watchdog.service']);
    run(['restart', 'tvclone-watchdog.service']);
  }
  return { copied, prefix, unitsDir };
}

function main(argv) {
  const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const repo = path.resolve(arg('--repo', path.join(__dirname, '..')));
  const prefix = arg('--prefix', DEFAULT_PREFIX);
  if (argv.includes('--check')) {
    const r = check({ repo, prefix });
    if (r.ok) { console.log('Root-run jobs use a current copy.'); return 0; }
    console.log(`Root-run jobs use a stale copy (${r.stale.join(', ')}). Refresh it with:\n  sudo node ${path.join(repo, 'scripts/install-root-copy.js')} --repo ${repo}`);
    return 1;
  }
  if (!(process.getuid && process.getuid() === 0) && !argv.includes('--no-systemctl')) {
    console.error(`Run it with sudo:  sudo node ${path.join(repo, 'scripts/install-root-copy.js')} --repo ${repo}`);
    return 64;
  }
  const r = install({ repo, prefix, unitsDir: arg('--units-dir', DEFAULT_UNITS), systemctl: !argv.includes('--no-systemctl'), log: console.log });
  console.log(`Copied ${r.copied.length} files to ${r.prefix}/app; backup, boot-repair and the watchdog loop now run from there.`);
  return 0;
}

module.exports = { filesNeeded, check, install, dropIn, JOBS };
if (require.main === module) process.exit(main(process.argv.slice(2)));
