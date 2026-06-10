// Reliability checks and repair helpers used by the dashboard and systemd jobs.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi']);

function runCmd(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: options.cwd, env: options.env || process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ ok: false, code: -1, stdout, stderr: stderr || 'Timed out' });
    }, timeoutMs);
    proc.stdout?.on('data', d => { stdout += d; });
    proc.stderr?.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: '', stderr: err.message });
    });
  });
}

function checkHttp(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode, json });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Timed out' });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function splitEnvList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function inferDownloadDirs(repoDir, config) {
  const explicit = splitEnvList(process.env.TVCLONE_DOWNLOAD_DIRS || process.env.DOWNLOAD_DIRS);
  if (explicit.length) return explicit;
  const singles = [process.env.TVCLONE_DOWNLOAD_DIR, process.env.DOWNLOAD_DIR, process.env.QBT_DOWNLOAD_DIR];
  const mediaRoot = config.folders?.find(f => String(f.path || '').startsWith('/mnt/media/')) ? '/mnt/media/Share' : '';
  const repoDownloads = path.join(repoDir, 'downloads');
  return unique([...singles, mediaRoot, fs.existsSync(repoDownloads) ? repoDownloads : '']);
}

// Deployments on this host: prod on 4800 (tvclone-prod.service), dev on 4801
// (tvclone-dev.service). Anything else falls back to the generic unit name.
function defaultAppService(port) {
  const p = String(port);
  if (p === '4800') return 'tvclone-prod.service';
  if (p === '4801') return 'tvclone-dev.service';
  return 'tvclone.service';
}

function getSettings(repoDir = process.cwd(), overrides = {}) {
  const configFile = overrides.configFile || path.join(repoDir, 'config.json');
  const config = readJson(configFile, { folders: [] });
  const requiredMedia = splitEnvList(process.env.TVCLONE_REQUIRED_MEDIA_DIRS);
  const mediaDirs = requiredMedia.length ? requiredMedia : (config.folders || []).map(f => f.path);
  const downloadDirs = inferDownloadDirs(repoDir, config);
  return {
    repoDir,
    dataDir: overrides.dataDir || path.join(repoDir, 'data'),
    configFile,
    config,
    port: overrides.port || process.env.PORT || '4800',
    appService: process.env.TVCLONE_SERVICE || process.env.APP_SERVICE || defaultAppService(overrides.port || process.env.PORT || '4800'),
    organizerService: process.env.ORGANIZER_SERVICE || 'tvclone-organizer.service',
    dockerService: process.env.DOCKER_MEDIA_SERVICE || 'docker-media.service',
    dockerContainers: splitEnvList(process.env.TVCLONE_DOCKER_CONTAINERS || 'gluetun,qbittorrent'),
    mediaDirs: unique(mediaDirs),
    downloadDirs: unique(downloadDirs),
    organizerLog: process.env.ORGANIZER_LOG || path.join(repoDir, 'media-organizer', 'media-organizer.log'),
    backupRoot: process.env.TVCLONE_BACKUP_ROOT || path.join(repoDir, 'data_backups'),
  };
}

async function mountInfo(target) {
  const r = await runCmd('findmnt', ['-T', target, '-n', '-o', 'TARGET,SOURCE,FSTYPE'], { timeoutMs: 3000 });
  if (!r.ok || !r.stdout) return { ok: false, error: r.stderr || 'findmnt unavailable' };
  const parts = r.stdout.split(/\s+/);
  return { ok: true, target: parts[0], source: parts[1], fstype: parts[2] };
}

async function diskInfo(target) {
  const r = await runCmd('df', ['-Pk', target], { timeoutMs: 5000 });
  if (!r.ok || !r.stdout) return { ok: false, error: r.stderr || 'df failed' };
  const line = r.stdout.trim().split('\n')[1];
  if (!line) return { ok: false, error: 'No df output' };
  const parts = line.trim().split(/\s+/);
  const usedPercent = parseInt(parts[4], 10) || 0;
  return {
    ok: true,
    filesystem: parts[0],
    totalKb: parseInt(parts[1], 10) || 0,
    usedKb: parseInt(parts[2], 10) || 0,
    availableKb: parseInt(parts[3], 10) || 0,
    usedPercent,
    mount: parts.slice(5).join(' '),
  };
}

async function checkPath(dir, role) {
  const result = { name: role, path: dir, ok: false, warnings: [] };
  try {
    const st = fs.statSync(dir);
    result.exists = true;
    result.isDirectory = st.isDirectory();
    if (!st.isDirectory()) result.warnings.push('Path exists but is not a directory');
  } catch {
    result.exists = false;
    result.warnings.push('Path is missing');
    return result;
  }

  if (dir.startsWith('/mnt/') || dir.startsWith('/media/')) {
    const mount = await mountInfo(dir);
    result.mount = mount;
    if (!mount.ok) result.warnings.push(mount.error || 'Could not verify mount');
    else if (mount.target === '/') result.warnings.push('Path resolves to root filesystem; media drive may not be mounted');
  }

  const disk = await diskInfo(dir);
  result.disk = disk;
  if (disk.ok && disk.usedPercent >= 90) result.warnings.push(`Disk is ${disk.usedPercent}% full`);
  if (disk.ok && disk.availableKb < 10 * 1024 * 1024) result.warnings.push('Less than 10GB free');

  result.ok = result.exists && result.isDirectory && result.warnings.length === 0;
  return result;
}

async function serviceStatus(service) {
  if (!service) return { ok: false, status: 'not configured' };
  const active = await runCmd('systemctl', ['is-active', service], { timeoutMs: 4000 });
  const enabled = await runCmd('systemctl', ['is-enabled', service], { timeoutMs: 4000 });
  return {
    ok: active.stdout === 'active',
    service,
    status: active.stdout || active.stderr || 'unknown',
    enabled: enabled.stdout || enabled.stderr || 'unknown',
  };
}

async function dockerStatus(containers) {
  const checks = [];
  for (const name of containers) {
    const r = await runCmd('docker', ['inspect', name], { timeoutMs: 7000 });
    if (!r.ok) {
      checks.push({ name, ok: false, status: 'unknown', error: r.stderr || 'Container not found' });
      continue;
    }
    try {
      const info = JSON.parse(r.stdout)[0];
      const state = info.State || {};
      checks.push({
        name,
        ok: state.Status === 'running' && (!state.Health || state.Health.Status === 'healthy'),
        status: state.Status || 'unknown',
        health: state.Health?.Status || null,
        restart: info.HostConfig?.RestartPolicy?.Name || '',
      });
    } catch (err) {
      checks.push({ name, ok: false, status: 'unknown', error: err.message });
    }
  }
  const qbtWeb = await checkHttp(process.env.QBT_URL || 'http://127.0.0.1:8080/', 3000);
  return { ok: checks.every(c => c.ok) && qbtWeb.ok, containers: checks, qbtWeb };
}

function readTail(file, maxBytes = 128 * 1024) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { ok: true, text: buf.toString('utf8'), mtimeMs: st.mtimeMs };
  } catch (err) {
    return { ok: false, text: '', error: err.message };
  }
}

function organizerLogStatus(logFile) {
  const tail = readTail(logFile);
  if (!tail.ok) return { ok: false, path: logFile, error: tail.error, recentErrors: [] };
  const lines = tail.text.split('\n').filter(Boolean);
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recentErrors = lines.filter(l => {
    if (!/ERROR|FAIL|Traceback|Exception|rate limit|No confident/i.test(l)) return false;
    const m = l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
    if (!m) return true;
    const ts = new Date(m[1].replace(' ', 'T')).getTime();
    return !Number.isFinite(ts) || ts >= cutoff;
  }).slice(-10);
  const ageMs = Date.now() - tail.mtimeMs;
  return {
    ok: recentErrors.length === 0 && ageMs < 15 * 60 * 1000,
    path: logFile,
    ageSeconds: Math.round(ageMs / 1000),
    recentErrors,
    warning: ageMs >= 15 * 60 * 1000 ? 'Organizer log has not changed recently' : '',
  };
}

async function status(options = {}) {
  const settings = getSettings(options.repoDir || process.cwd(), options);
  const appUrl = `http://127.0.0.1:${settings.port}/api/health`;
  const checks = {
    app: await checkHttp(appUrl, 5000),
    appService: await serviceStatus(settings.appService),
    organizerService: await serviceStatus(settings.organizerService),
    dockerService: await serviceStatus(settings.dockerService),
    docker: await dockerStatus(settings.dockerContainers),
    organizerLog: organizerLogStatus(settings.organizerLog),
    media: [],
    downloads: [],
  };
  checks.app.ok = !!(checks.app.ok && checks.app.json?.ready);
  for (const dir of settings.mediaDirs) checks.media.push(await checkPath(dir, 'media'));
  for (const dir of settings.downloadDirs) checks.downloads.push(await checkPath(dir, 'downloads'));

  const allChecks = [
    checks.app,
    checks.appService,
    checks.organizerService,
    checks.dockerService,
    checks.docker,
    ...checks.media,
    ...checks.downloads,
  ];
  const warnings = [];
  for (const c of allChecks) {
    if (!c.ok) warnings.push(c.path || c.service || c.name || c.error || 'Unhealthy check');
    if (Array.isArray(c.warnings)) warnings.push(...c.warnings.map(w => `${c.path}: ${w}`));
  }
  if (checks.organizerLog.warning) warnings.push(checks.organizerLog.warning);
  if (!checks.organizerLog.ok && checks.organizerLog.error) warnings.push(checks.organizerLog.error);
  for (const e of checks.organizerLog.recentErrors || []) warnings.push(e);

  return {
    ok: warnings.length === 0,
    generatedAt: new Date().toISOString(),
    settings: {
      port: settings.port,
      appService: settings.appService,
      organizerService: settings.organizerService,
      dockerService: settings.dockerService,
      mediaDirs: settings.mediaDirs,
      downloadDirs: settings.downloadDirs,
    },
    checks,
    warnings: unique(warnings).slice(0, 25),
  };
}

function isVideoFile(file) {
  return VIDEO_EXT.has(path.extname(file).toLowerCase());
}

function removeEmptyDirs(root, removed = []) {
  if (!root || !fs.existsSync(root)) return removed;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(root, entry.name), removed);
  }
  if (removed.length > 500) return removed;
  try {
    const remaining = fs.readdirSync(root);
    if (remaining.length === 0) {
      fs.rmdirSync(root);
      removed.push(root);
    }
  } catch {}
  return removed;
}

function cleanEmptyMediaFolders(mediaDirs) {
  const removed = [];
  for (const root of mediaDirs) {
    if (!root || !fs.existsSync(root)) continue;
    let children = [];
    try { children = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of children) {
      if (entry.isDirectory()) removeEmptyDirs(path.join(root, entry.name), removed);
    }
  }
  return removed;
}

function cleanOldTranscodeDirs(repoDir, olderMs = 30 * 60 * 1000) {
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(repoDir, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('transcode_tmp')) continue;
    const tmpRoot = path.join(repoDir, entry.name);
    let sessions = [];
    try { sessions = fs.readdirSync(tmpRoot, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      const full = path.join(tmpRoot, session.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (Date.now() - st.mtimeMs < olderMs) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch {}
    }
  }
  return removed;
}

function quarantineWeirdDownloads(downloadDirs) {
  const moved = [];
  for (const dir of downloadDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const quarantine = path.join(dir, '_quarantine');
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.toLowerCase() === 'incomplete') continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && !isVideoFile(entry.name) && !['.srt', '.vtt'].includes(path.extname(entry.name).toLowerCase())) continue;
      if (!/[A-Za-z0-9]/.test(entry.name)) {
        try {
          fs.mkdirSync(quarantine, { recursive: true });
          const dest = path.join(quarantine, entry.name || `item-${Date.now()}`);
          fs.renameSync(full, dest);
          moved.push({ from: full, to: dest, reason: 'Unreadable name' });
        } catch {}
      }
    }
  }
  return moved;
}

async function repair(options = {}) {
  const settings = getSettings(options.repoDir || process.cwd(), options);
  const before = await status({ ...options, repoDir: settings.repoDir });
  const results = [];

  const folderProblem = [...before.checks.media, ...before.checks.downloads].some(c => !c.exists || !c.isDirectory);
  if (folderProblem) {
    results.push({ step: 'preflight', ok: false, message: 'One or more required folders are missing. Refusing file cleanup.' });
    return { ok: false, before, results, after: before };
  }

  const transcodeRemoved = cleanOldTranscodeDirs(settings.repoDir, 15 * 60 * 1000);
  results.push({ step: 'clean-transcodes', ok: true, count: transcodeRemoved.length, paths: transcodeRemoved.slice(0, 20) });

  const emptyRemoved = cleanEmptyMediaFolders(settings.mediaDirs);
  results.push({ step: 'clean-empty-folders', ok: true, count: emptyRemoved.length, paths: emptyRemoved.slice(0, 20) });

  const quarantined = quarantineWeirdDownloads(settings.downloadDirs);
  results.push({ step: 'quarantine-weird-downloads', ok: true, count: quarantined.length, items: quarantined.slice(0, 20) });

  const after = await status({ ...options, repoDir: settings.repoDir });
  return { ok: after.ok, before, results, after };
}

async function systemctl(action, service) {
  return runCmd('systemctl', [action, service], { timeoutMs: 20000 });
}

async function bootRepair(options = {}) {
  const settings = getSettings(options.repoDir || process.cwd(), options);
  const first = await status({ ...options, repoDir: settings.repoDir });
  const results = [];
  const mediaMissing = [...first.checks.media, ...first.checks.downloads].some(c => !c.exists || !c.isDirectory);
  if (mediaMissing) {
    return { ok: false, first, results: [{ step: 'preflight', ok: false, message: 'Required media/download path missing; services were not started.' }] };
  }

  results.push({ step: 'docker-service', ...(await systemctl('start', settings.dockerService)) });
  results.push({ step: 'app-service', ...(await systemctl('start', settings.appService)) });
  results.push({ step: 'organizer-service', ...(await systemctl('start', settings.organizerService)) });
  const cleanup = await repair({ ...options, repoDir: settings.repoDir });
  results.push(...cleanup.results);
  const after = await status({ ...options, repoDir: settings.repoDir });
  return { ok: after.ok, first, results, after };
}

async function watchdog(options = {}) {
  const settings = getSettings(options.repoDir || process.cwd(), options);
  const first = await status({ ...options, repoDir: settings.repoDir });
  const results = [];
  const folderProblem = [...first.checks.media, ...first.checks.downloads].some(c => !c.exists || !c.isDirectory || (c.warnings || []).length);
  if (folderProblem) {
    results.push({ step: 'organizer-stop-missing-drive', ...(await systemctl('stop', settings.organizerService)) });
    return { ok: false, first, results, after: await status({ ...options, repoDir: settings.repoDir }) };
  }
  if (!first.checks.dockerService.ok || !first.checks.docker.ok) {
    results.push({ step: 'docker-restart', ...(await systemctl('restart', settings.dockerService)) });
  }
  if (!first.checks.app.ok || !first.checks.appService.ok) {
    results.push({ step: 'app-restart', ...(await systemctl('restart', settings.appService)) });
  }
  if (!first.checks.organizerService.ok) {
    results.push({ step: 'organizer-restart', ...(await systemctl('restart', settings.organizerService)) });
  }
  const transcodeRemoved = cleanOldTranscodeDirs(settings.repoDir, 30 * 60 * 1000);
  results.push({ step: 'clean-stale-transcodes', ok: true, count: transcodeRemoved.length, paths: transcodeRemoved.slice(0, 20) });
  const after = await status({ ...options, repoDir: settings.repoDir });
  return { ok: after.ok, first, results, after };
}

async function backup(options = {}) {
  const settings = getSettings(options.repoDir || process.cwd(), options);
  const target = path.join(settings.backupRoot, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(settings.backupRoot, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  const files = [
    'config.json',
    path.join('data', 'sessions.json'),
    path.join('data', 'media_info.json'),
    path.join('data', 'metadata_overrides.json'),
    path.join('data', 'omdb_cache.json'),
    path.join('data', 'library_cache.json'),
  ];
  let profileFiles = [];
  try { profileFiles = fs.readdirSync(settings.dataDir).filter(f => /^profile_.*\.json$/.test(f)).map(f => path.join('data', f)); } catch {}
  const copied = [];
  for (const rel of [...files, ...profileFiles]) {
    const src = path.join(settings.repoDir, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(rel);
  }
  if (fs.existsSync(settings.organizerLog)) {
    const dest = path.join(target, 'media-organizer.log');
    fs.copyFileSync(settings.organizerLog, dest);
    copied.push('media-organizer.log');
  }
  return { ok: true, target, copied };
}

module.exports = {
  getSettings,
  runCmd,
  checkHttp,
  status,
  repair,
  bootRepair,
  watchdog,
  backup,
  cleanOldTranscodeDirs,
  cleanEmptyMediaFolders,
};
