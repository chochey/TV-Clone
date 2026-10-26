#!/usr/bin/env node
// Weekly update of the Docker containers (lib/container-updates.js). Run by the user timer
// chochey-container-update.timer as blue, who can use Docker; the app cannot, so the result is
// written to container-updates.json in the data dir for the Dashboard.
//
//   node scripts/update-containers.js            update now if nothing plays or downloads, else say busy
//   node scripts/update-containers.js --wait     wait up to 12 hours for a quiet moment (the timer uses this)
//   node scripts/update-containers.js --status   only record each container's version and build date
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const createContainerUpdates = require('../lib/container-updates');
const { quietCheck, createSettingsStore } = createContainerUpdates;

const dataDir = process.env.TVCLONE_DATA_DIR || '/srv/chocheytv/data';
const composeDir = process.env.CHOCHEY_COMPOSE_DIR || '/home/blue/Desktop/Repos/Docker-Media';
const statusFile = path.join(dataDir, 'container-updates.json');
// Settings folders (bind mounts in the compose file) copied before a switch; they hold qBittorrent's
// password hash, so the copies live in a private folder outside the compose repo.
const settings = createSettingsStore({
  dirs: { qbittorrent: path.join(composeDir, 'qbittorrent', 'config'), gluetun: path.join(composeDir, 'gluetun') },
  backupRoot: process.env.CHOCHEY_SETTINGS_BACKUPS || path.join(process.env.HOME || '/home/blue', '.local/state/chochey-container-updates'),
});
const env = { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock' };

const run = (cmd, args, { cwd, timeout = 120_000 } = {}) => new Promise(resolve => {
  execFile(cmd, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr || error?.message || '') });
  });
});
const readJSON = async f => JSON.parse(await fs.promises.readFile(f, 'utf8'));
async function writeStatus(status) {
  const tmp = `${statusFile}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(status, null, 2) + '\n', { mode: 0o644 });
  await fs.promises.chmod(tmp, 0o644);
  await fs.promises.rename(tmp, statusFile);
}
const log = line => console.log(`${new Date().toISOString()} ${line}`);

const updater = createContainerUpdates({
  run, composeDir, writeStatus, log, saveSettings: settings.save, restoreSettings: settings.restore,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  isQuiet: () => quietCheck({ dataDir, readdir: d => fs.promises.readdir(d), readJSON }),
  readinessUpdatedAt: async () => (await readJSON(path.join(dataDir, 'download-readiness.json')).catch(() => ({}))).updatedAt || 0,
});

const args = process.argv.slice(2);
(args.includes('--status') ? updater.status() : updater.update({ wait: args.includes('--wait') }))
  .then(s => {
    for (const c of s.containers) log(`  ${c.name}: built ${c.builtAt?.slice(0, 10) || '?'}${c.updated ? ` (was ${c.previousBuiltAt?.slice(0, 10)})` : ''}${c.error ? ` ${c.error}` : ''}`);
    process.exitCode = s.ok ? 0 : 1;
  })
  .catch(async error => {
    log(`stopped: ${error.message}`);
    await writeStatus({ version: 1, at: new Date().toISOString(), ok: false, result: 'failed', reason: error.message,
      error: error.code || 'ERROR', containers: [] }).catch(() => {});
    process.exitCode = 1;
  });
