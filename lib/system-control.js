// System control: systemctl + docker shell wrappers. Factory module.
const { spawn } = require('child_process');

module.exports = function createSystemControl({ ORGANIZER_SERVICE, ALLOWED_CONTAINERS, ALLOWED_DOCKER_ACTIONS }) {
  const containers = new Set(ALLOWED_CONTAINERS);
  const dockerActions = new Set(ALLOWED_DOCKER_ACTIONS);

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

  function dockerInspect(containers) {
    return Promise.all(containers.map(name => new Promise(resolve => {
      const proc = spawn('docker', ['inspect', '--format', '{{.State.Status}}', name]);
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.on('close', code => resolve([name, code === 0 ? out.trim() : 'unknown']));
      proc.on('error', () => resolve([name, 'unknown']));
    }))).then(entries => Object.fromEntries(entries));
  }

  return { organizerServiceCmd, dockerCmd, dockerInspect, ALLOWED_CONTAINERS: containers, ALLOWED_DOCKER_ACTIONS: dockerActions };
};
