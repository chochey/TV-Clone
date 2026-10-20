// Organizer service and Docker controls for the admin pages, plus the
// organizer dry-run preview. The systemctl/docker wrappers live in
// lib/system-control.js; this registers the routes with explicit dependencies.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function registerSystemControlRoutes(app, {
  requireAdminSession, requirePermission, organizerScript, organizerAliasFile,
  python = process.env.ORGANIZER_PYTHON || 'python3', sys, selfRestart = null,
}) {
  const { organizerServiceCmd, dockerCmd, dockerInspect, dockerComposeRepair } = sys;

  // The app restarts itself (lib/self-restart.js); systemd brings it back. The reply is sent
  // first, and the shutdown follows a moment later.
  app.post('/api/system/restart', requireAdminSession, (req, res) => {
    if (!selfRestart) return res.status(503).json({ ok: false, error: 'Restarting is not available on this install.' });
    res.json({ ok: true });
    selfRestart.request(`admin ${req.session?.name || req.session?.profileId || ''}`.trim());
  });

  app.post('/api/organizer/preview', requireAdminSession, async (_req, res) => {
    if (!fs.existsSync(organizerScript)) {
      return res.status(404).json({ ok: false, error: `Organizer script not found: ${organizerScript}` });
    }
    const child = spawn(python, [organizerScript, '--dry-run'], {
      cwd: path.dirname(organizerScript),
      env: { ...process.env, ORGANIZER_ALIAS_FILE: organizerAliasFile, ORGANIZER_PREVIEW: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = chunk => {
      output += chunk.toString();
      if (output.length > 60000) output = output.slice(-60000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, 60000);
    // A failed spawn emits 'error' and then 'close' — only respond once.
    let responded = false;
    child.on('error', err => {
      clearTimeout(timeout);
      if (responded) return;
      responded = true;
      res.status(500).json({ ok: false, error: err.message });
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (responded) return;
      responded = true;
      const lines = output.split('\n').filter(l => l.trim()).slice(-300);
      res.json({ ok: code === 0, code, lines, truncated: output.length >= 60000 });
    });
  });

  app.get('/api/organizer/status', requirePermission('canOrganizer'), async (_req, res) => {
    const result = await organizerServiceCmd('status');
    res.json({ ok: true, active: result.code === 0, code: result.code });
  });

  for (const [action, guard] of [['start', requireAdminSession], ['stop', requireAdminSession], ['restart', requirePermission('canRestart')]]) {
    app.post(`/api/organizer/${action}`, guard, async (_req, res) => {
      const result = await organizerServiceCmd(action);
      res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
    });
  }

  app.get('/api/docker/status', requireAdminSession, async (_req, res) => {
    res.json(await dockerInspect([...sys.ALLOWED_CONTAINERS]));
  });

  app.post('/api/docker/:action/:container', requireAdminSession, async (req, res) => {
    const { action, container } = req.params;
    const result = await dockerCmd(action, container);
    res.json({ ok: result.ok, error: result.ok ? undefined : result.stderr });
  });

  app.post('/api/docker/repair', requireAdminSession, async (_req, res) => {
    res.json(await dockerComposeRepair());
  });
};
