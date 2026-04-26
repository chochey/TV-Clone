// Auth primitives: password hashing, sessions, admin tokens, cast tokens.
// Factory module: require('./lib/auth')(deps).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const CAST_TOKEN_TTL = 5 * 60 * 1000;             // 5 minutes sliding window
const VALID_PERMISSIONS = ['canDownload', 'canScan', 'canRestart', 'canLogs'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return !password;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

module.exports = function createAuth({ DATA_DIR, COOKIE_NAME, ADMIN_COOKIE_NAME, saveJSON, cleanupIntervalMs }) {
  const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

  const sessions = new Map();       // sessionToken -> { profileId, role, permissions, createdAt }
  const adminTokens = new Map();    // adminToken   -> sessionToken
  const castTokens = new Map();     // castToken    -> { profileId, role, permissions, createdAt }

  try {
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    const now = Date.now();
    for (const [token, session] of Object.entries(saved)) {
      if (now - session.createdAt < SESSION_MAX_AGE) sessions.set(token, session);
    }
    if (sessions.size > 0) console.log(`[Sessions] Restored ${sessions.size} session(s) from disk`);
  } catch {}

  let _sessionSaveTimer = null;
  function persistSessions() {
    if (_sessionSaveTimer) return;
    _sessionSaveTimer = setTimeout(() => {
      _sessionSaveTimer = null;
      saveJSON(SESSIONS_FILE, Object.fromEntries(sessions));
    }, 5000);
  }

  function createSession(profileId, role, permissions) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { profileId, role, permissions: permissions || [], createdAt: Date.now() });
    persistSessions();
    return token;
  }

  function createAdminToken(sessionToken) {
    const aToken = crypto.randomBytes(24).toString('hex');
    adminTokens.set(aToken, sessionToken);
    return aToken;
  }

  function revokeAdminToken(sessionToken) {
    for (const [aToken, sToken] of adminTokens) {
      if (sToken === sessionToken) { adminTokens.delete(aToken); break; }
    }
  }

  function getSession(req) {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
    const token = match ? match[1] : req.headers['x-session-token'];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
      sessions.delete(token);
      return null;
    }
    session.createdAt = Date.now(); // sliding expiration
    return session;
  }

  function requireAuth(req, res, next) {
    const session = getSession(req);
    if (session) { req.session = session; return next(); }
    const castToken = req.query.cast_token;
    if (castToken) {
      const ct = castTokens.get(castToken);
      if (ct && Date.now() - ct.createdAt < CAST_TOKEN_TTL) {
        ct.createdAt = Date.now();
        req.session = { profileId: ct.profileId, role: ct.role, permissions: ct.permissions };
        return next();
      }
      castTokens.delete(castToken);
    }
    return res.status(401).json({ error: 'Login required' });
  }

  function requireAdminSession(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Login required' });
    if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.session = session;
    next();
  }

  // Admin-token cookie (separate from session cookie) — validates the token
  // and re-registers it against the current session if the server restarted
  // and wiped adminTokens (so users aren't forced to re-log on every restart).
  function resolveAdminToken(req) {
    const cookieHeader = req.headers.cookie || '';
    const adminMatch = cookieHeader.match(new RegExp(`${ADMIN_COOKIE_NAME}=([a-f0-9]{48})`));
    const aToken = adminMatch ? adminMatch[1] : req.headers['x-admin-token'];
    if (!aToken) return false;
    if (adminTokens.has(aToken) && sessions.has(adminTokens.get(aToken))) return true;
    const session = getSession(req);
    if (!session) return false;
    const cookieMatch = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]{64})`));
    const sToken = cookieMatch ? cookieMatch[1] : null;
    if (!sToken) return false;
    adminTokens.set(aToken, sToken);
    return true;
  }

  function requireAdmin(req, res, next) {
    if (!resolveAdminToken(req)) return res.status(403).json({ error: 'Unauthorized' });
    next();
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      if (!resolveAdminToken(req)) return res.status(403).json({ error: 'Unauthorized' });
      const session = getSession(req);
      if (!session) return res.status(401).json({ error: 'Login required' });
      if (session.role === 'admin') return next();
      if (session.permissions && session.permissions.includes(permission)) return next();
      return res.status(403).json({ error: 'Permission denied' });
    };
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, session] of sessions) {
      if (now - session.createdAt > SESSION_MAX_AGE) {
        sessions.delete(token);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[Sessions] Cleaned ${cleaned} expired session(s), ${sessions.size} active`);
      persistSessions();
    }
    for (const [token, ct] of castTokens) {
      if (now - ct.createdAt > CAST_TOKEN_TTL) castTokens.delete(token);
    }
  }, cleanupIntervalMs);

  return {
    hashPassword, verifyPassword,
    sessions, adminTokens, castTokens,
    createSession, createAdminToken, revokeAdminToken,
    getSession, requireAuth, requireAdminSession,
    resolveAdminToken, requireAdmin, requirePermission,
    persistSessions,
    cleanupTimer,
    SESSION_MAX_AGE, CAST_TOKEN_TTL, VALID_PERMISSIONS,
  };
};

module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.SESSION_MAX_AGE = SESSION_MAX_AGE;
module.exports.CAST_TOKEN_TTL = CAST_TOKEN_TTL;
module.exports.VALID_PERMISSIONS = VALID_PERMISSIONS;
