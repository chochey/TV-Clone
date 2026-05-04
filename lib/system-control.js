// System control: systemctl + docker shell wrappers. Factory module.
const { spawn } = require('child_process');
const http = require('http');

function runCmd(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', d => stdout += d);
    proc.stderr?.on('data', d => stderr += d);
    proc.on('close', code => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
    proc.on('error', err => resolve({ ok: false, code: -1, stdout: '', stderr: err.message }));
  });
}

function checkHttp(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Timed out' });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
  });
}

module.exports = function createSystemControl({ ORGANIZER_SERVICE, ALLOWED_CONTAINERS, ALLOWED_DOCKER_ACTIONS }) {
  const containers = new Set(ALLOWED_CONTAINERS);
  const dockerActions = new Set(ALLOWED_DOCKER_ACTIONS);
  const composeDir = process.env.DOCKER_MEDIA_DIR || '/home/blue/Desktop/Repos/Docker-Media';

  function organizerServiceCmd(action) {
    return new Promise((resolve) => {
      const proc = spawn('sudo', ['systemctl', action, ORGANIZER_SERVICE]);
      let stderr = '';
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => resolve({ ok: code === 0, code, stderr: stderr.trim() }));
      proc.on('error', err => resolve({ ok: false, code: -1, stderr: err.message }));
    });
  }

  function dockerCmd(action, container) {
    return new Promise((resolve) => {
      if (!containers.has(container) || !dockerActions.has(action)) {
        return resolve({ ok: false, stderr: 'Invalid container or action' });
      }
      const proc = spawn('docker', [action, container]);
      let stderr = '';
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => resolve({ ok: code === 0, code, stderr: stderr.trim() }));
      proc.on('error', err => resolve({ ok: false, code: -1, stderr: err.message }));
    });
  }

  async function dockerInspect(containerNames) {
    const entries = await Promise.all(containerNames.map(async (name) => {
      const result = await runCmd('docker', ['inspect', name]);
      if (!result.ok) {
        return [name, { status: 'unknown', health: 'unknown', ok: false, error: result.stderr || 'Container not found' }];
      }
      try {
        const info = JSON.parse(result.stdout)[0];
        const state = info.State || {};
        return [name, {
          status: state.Status || 'unknown',
          health: state.Health?.Status || null,
          ok: state.Status === 'running' && (!state.Health || state.Health.Status === 'healthy'),
          exitCode: state.ExitCode,
          error: state.Error || '',
          finishedAt: state.FinishedAt || '',
          restart: info.HostConfig?.RestartPolicy?.Name || '',
        }];
      } catch (err) {
        return [name, { status: 'unknown', health: 'unknown', ok: false, error: err.message }];
      }
    }));
    const status = Object.fromEntries(entries);
    const qbt = await checkHttp('http://127.0.0.1:8080/');
    status.qbittorrentWeb = {
      ok: qbt.ok,
      status: qbt.ok ? 'reachable' : 'unreachable',
      statusCode: qbt.statusCode || null,
      error: qbt.error || '',
    };
    status.warning = buildDockerWarning(status);
    return status;
  }

  function buildDockerWarning(status) {
    if (status.gluetun?.status !== 'running') return status.gluetun?.error || 'VPN container is not running.';
    if (status.gluetun?.health && status.gluetun.health !== 'healthy') return 'VPN container is running but not healthy.';
    if (status.qbittorrent?.status !== 'running') return status.qbittorrent?.error || 'qBittorrent container is not running.';
    if (!status.qbittorrentWeb?.ok) return status.qbittorrentWeb?.error || 'qBittorrent Web UI is unreachable.';
    return '';
  }

  async function dockerComposeRepair() {
    const first = await runCmd('docker', ['compose', 'up', '-d', 'gluetun', 'qbittorrent'], { cwd: composeDir });
    if (first.ok) return { ok: true, repaired: false, step: 'compose-up', output: first.stdout };

    const remove = await runCmd('docker', ['compose', 'rm', '-sf', 'gluetun', 'qbittorrent'], { cwd: composeDir });
    const network = await runCmd('docker', ['network', 'rm', 'docker-media_default']);
    const recreate = await runCmd('docker', ['compose', 'up', '-d', 'gluetun', 'qbittorrent'], { cwd: composeDir });
    return {
      ok: recreate.ok,
      repaired: recreate.ok,
      step: 'recreate',
      error: recreate.ok ? undefined : (recreate.stderr || remove.stderr || network.stderr || first.stderr),
      details: [first.stderr, remove.stderr, network.stderr, recreate.stderr].filter(Boolean).join('\n'),
    };
  }

  return { organizerServiceCmd, dockerCmd, dockerInspect, dockerComposeRepair, ALLOWED_CONTAINERS: containers, ALLOWED_DOCKER_ACTIONS: dockerActions };
};
