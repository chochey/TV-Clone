// Sign-in and accounts: login/logout, the current user, cast tokens and
// profile management. Sessions and password hashing live in lib/auth.js;
// this registers the routes with explicit dependencies from server.js.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

function removeFileIfPresent(file) {
  if (fs.existsSync(file)) try { fs.unlinkSync(file); } catch {}
}

module.exports = function registerAccountRoutes(app, {
  getConfig, saveConfig, loadProfileData, saveProfileData, profileDataCache, profileDataPath, removeFile = removeFileIfPresent,
  hashPassword, verifyPassword, sessions, castTokens, createSession, createAdminToken, revokeAdminToken,
  persistSessions, getSession, requireAuth, requireAdminSession, VALID_PERMISSIONS, SESSION_MAX_AGE,
  recordLogin, COOKIE_NAME, ADMIN_COOKIE_NAME, COOKIE_SECURE, LOGIN_RATE_WINDOW_MS, LOGIN_MAX_ATTEMPTS,
  isQualityPreset, castHost, port, networkInterfaces = os.networkInterfaces, log = console.log, downloaderConfigured = () => false,
}) {
  // Rate-limit key is `${ip}|${username}` so one user locking themselves out on a
  // shared NAT doesn't also lock out everyone else. Entries expire after 2×window.
  const loginAttempts = new Map(); // key -> { count, lastAttempt }
  const loginRateKey = (ip, username) => `${ip}|${(username || '').toLowerCase()}`;
  setInterval(() => {
    const cutoff = Date.now() - LOGIN_RATE_WINDOW_MS * 2;
    for (const [k, v] of loginAttempts) if (v.lastAttempt < cutoff) loginAttempts.delete(k);
  }, LOGIN_RATE_WINDOW_MS).unref();

  app.post('/api/login', (req, res) => {
    const config = getConfig();
    const ip = req.ip;
    const now = Date.now();
    const { username, password, profileId } = req.body;
    const key = loginRateKey(ip, username || profileId);
    let bucket = loginAttempts.get(key);
    if (!bucket) { bucket = { count: 0, lastAttempt: 0 }; loginAttempts.set(key, bucket); }
    if (now - bucket.lastAttempt > LOGIN_RATE_WINDOW_MS) bucket.count = 0;
    if (bucket.count >= LOGIN_MAX_ATTEMPTS) {
      recordLogin({ username, ip, success: false, reason: 'Rate limited' });
      return res.status(429).json({ error: 'Too many attempts. Try again in 5 minutes.' });
    }

    // Support both username-based login (new) and profileId-based login (legacy/internal)
    let profile;
    if (username) {
      profile = config.profiles.find(p => (p.username || '').toLowerCase() === username.toLowerCase());
    } else if (profileId) {
      profile = config.profiles.find(p => p.id === profileId);
    }
    if (!profile) {
      bucket.count++;
      bucket.lastAttempt = now;
      recordLogin({ username, ip, success: false, reason: 'Unknown user' });
      return res.status(403).json({ error: 'Invalid username or password' });
    }

    bucket.lastAttempt = now;

    if (!verifyPassword(password || '', profile.password || '')) {
      bucket.count++;
      recordLogin({ profileName: profile.name, username, ip, success: false, reason: 'Wrong password' });
      return res.status(403).json({ error: 'Invalid username or password' });
    }

    // Successful login — clear the bucket
    loginAttempts.delete(key);
    recordLogin({ profileName: profile.name, username, ip, success: true });

    const role = profile.role || 'user';
    const permissions = role === 'admin' ? [...VALID_PERMISSIONS] : (profile.permissions || []);
    const token = createSession(profile.id, role, permissions);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', maxAge: SESSION_MAX_AGE });
    // Any permission at all needs the secondary token cookie — don't enumerate,
    // so future permissions can't silently miss it.
    if (role === 'admin' || permissions.length > 0) {
      const aToken = createAdminToken(token);
      res.cookie(ADMIN_COOKIE_NAME, aToken, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', maxAge: SESSION_MAX_AGE });
    }
    res.json({ ok: true, role, profileId: profile.id, name: profile.name, permissions });
  });

  app.post('/api/logout', (req, res) => {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
    if (match) { revokeAdminToken(match[1]); sessions.delete(match[1]); persistSessions(); }
    res.clearCookie(COOKIE_NAME);
    res.clearCookie(ADMIN_COOKIE_NAME);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    const session = getSession(req);
    if (!session) return res.json({ loggedIn: false });
    const profile = getConfig().profiles.find(p => p.id === session.profileId);
    const profileData = loadProfileData(session.profileId);
    res.json({ loggedIn: true, profileId: session.profileId, role: session.role, permissions: session.permissions || [], name: profile?.name, avatar: profile?.avatar, quality: profileData.quality || 'auto',
      // Pages that would ask the download client (Episodes) skip it when none is set up, instead of logging a 503 on every visit.
      downloaderConfigured: downloaderConfigured() });
  });

  app.put('/api/me/quality', requireAuth, (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not logged in' });
    const { quality } = req.body;
    if (!isQualityPreset(quality)) return res.status(400).json({ error: 'Invalid quality preset' });
    const data = loadProfileData(session.profileId);
    data.quality = quality;
    saveProfileData(session.profileId, data);
    res.json({ ok: true, quality });
  });

  // Chromecast: generate a short-lived token for media access without cookies
  app.post('/api/cast-token', requireAuth, (req, res) => {
    const token = crypto.randomBytes(16).toString('hex');
    castTokens.set(token, {
      profileId: req.session.profileId,
      role: req.session.role,
      permissions: req.session.permissions || [],
      createdAt: Date.now(),
    });
    res.json({ token });
  });

  // Chromecast: return server LAN IP so Cast device can reach media URLs
  app.get('/api/server-info', requireAuth, (_req, res) => {
    if (castHost) return res.json({ lanHost: castHost, port });
    // Auto-detect first non-loopback IPv4 address
    for (const addrs of Object.values(networkInterfaces())) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return res.json({ lanHost: addr.address, port });
        }
      }
    }
    res.json({ lanHost: 'localhost', port });
  });

  app.post('/api/profiles', requireAdminSession, (req, res) => {
    const config = getConfig();
    const { name, username, pin, avatar, password, role, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const uname = (username || name.toLowerCase().replace(/[^a-z0-9]/g, '')).toLowerCase();
    if (config.profiles.some(p => (p.username || '').toLowerCase() === uname)) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    if (!password) return res.status(400).json({ error: 'Password required' });
    const id = crypto.randomBytes(6).toString('hex');
    const validPerms = Array.isArray(permissions) ? permissions.filter(p => VALID_PERMISSIONS.includes(p)) : [];
    // Created in the canNotify era: mark migrated so the one-time notify
    // back-fill doesn't grant a permission the admin deliberately left off.
    const profile = { id, name, username: uname, pin: pin ? hashPassword(pin) : '', avatar: avatar || '#00a4dc', role: role || 'user', password: password ? hashPassword(password) : '', permissions: validPerms, _notifyMigrated: true };
    config.profiles.push(profile);
    saveConfig();
    res.json({ ok: true, profile: { id, name, username: uname, hasPin: !!pin, hasPassword: !!password, avatar, role: profile.role, permissions: validPerms } });
  });

  // Sessions snapshot role+permissions at login and are restored from disk on
  // restart, so a token outlives the account it belongs to: deleting a profile
  // or demoting it leaves a fully working cookie behind. Every change to who a
  // profile IS must therefore revoke its sessions. exceptToken spares the
  // caller's own cookie so an admin editing themselves isn't logged out.
  function revokeProfileSessions(profileId, exceptToken = null) {
    let revoked = 0;
    for (const [token, s] of sessions) {
      if (s.profileId !== profileId || token === exceptToken) continue;
      revokeAdminToken(token);
      sessions.delete(token);
      revoked++;
    }
    if (revoked) {
      persistSessions();
      log(`[Sessions] Revoked ${revoked} session(s) for profile ${profileId}`);
    }
    return revoked;
  }

  function sessionTokenOf(req) {
    const m = (req.headers.cookie || '').match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
    return m ? m[1] : (req.headers['x-session-token'] || null);
  }

  app.put('/api/profiles/:id', requireAdminSession, (req, res) => {
    const config = getConfig();
    const p = config.profiles.find(p => p.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    if (req.body.name) p.name = req.body.name;
    if (req.body.username !== undefined) {
      const uname = req.body.username.toLowerCase();
      if (config.profiles.some(x => x.id !== p.id && (x.username || '').toLowerCase() === uname)) {
        return res.status(400).json({ error: 'Username already taken' });
      }
      p.username = uname;
    }
    if (req.body.pin !== undefined) p.pin = req.body.pin ? hashPassword(req.body.pin) : '';
    if (req.body.avatar) p.avatar = req.body.avatar;
    if (req.body.role) p.role = req.body.role;
    if (req.body.permissions !== undefined) p.permissions = Array.isArray(req.body.permissions) ? req.body.permissions.filter(x => VALID_PERMISSIONS.includes(x)) : [];
    if (req.body.password !== undefined) {
      if (!req.body.password) return res.status(400).json({ error: 'Password cannot be blank' });
      p.password = hashPassword(req.body.password);
    }
    saveConfig();
    // A new password must invalidate the old cookies, and a role/permission
    // change only takes effect once the stale snapshot in the session is gone.
    const authzChanged = req.body.password !== undefined || req.body.role !== undefined || req.body.permissions !== undefined;
    if (authzChanged) revokeProfileSessions(p.id, sessionTokenOf(req));
    res.json({ ok: true });
  });

  // Anyone changes their own password with the current one; their other devices are signed out.
  app.put('/api/me/password', requireAuth, (req, res) => {
    const session = getSession(req);
    const profile = getConfig().profiles.find(p => p.id === session.profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const current = String(req.body?.current || ''), next = String(req.body?.next || '');
    if (!next) return res.status(400).json({ error: 'New password cannot be blank' });
    if (!verifyPassword(current, profile.password || '')) return res.status(403).json({ error: 'Current password is wrong' });
    profile.password = hashPassword(next);
    saveConfig();
    revokeProfileSessions(profile.id, sessionTokenOf(req));
    res.json({ ok: true });
  });

  app.delete('/api/profiles/:id', requireAdminSession, (req, res) => {
    const config = getConfig();
    if (config.profiles.length <= 1) return res.status(400).json({ error: 'Must keep at least one profile' });
    config.profiles = config.profiles.filter(p => p.id !== req.params.id);
    saveConfig();
    revokeProfileSessions(req.params.id);
    profileDataCache.delete(req.params.id);
    removeFile(profileDataPath(req.params.id));
    res.json({ ok: true });
  });

  const pinAttempts = {}; // ip -> { count, lastAttempt }
  app.post('/api/profiles/:id/verify-pin', requireAuth, (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    if (!pinAttempts[ip]) pinAttempts[ip] = { count: 0, lastAttempt: 0 };
    // Reset after rate-limit window
    if (now - pinAttempts[ip].lastAttempt > LOGIN_RATE_WINDOW_MS) pinAttempts[ip].count = 0;
    if (pinAttempts[ip].count >= LOGIN_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

    const p = getConfig().profiles.find(p => p.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    if (!p.pin) return res.json({ ok: true });
    pinAttempts[ip].lastAttempt = now;
    const input = String(req.body.pin || '');
    if (verifyPassword(input, p.pin)) return res.json({ ok: true });
    pinAttempts[ip].count++;
    res.status(403).json({ error: 'Incorrect PIN' });
  });
};
