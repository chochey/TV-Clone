const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createAuth = require('../auth');
const register = require('./accounts');

const COOKIE_NAME = 'sid', ADMIN_COOKIE_NAME = 'aid';

function fixture(t, { castHost = '', maxAttempts = 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-'));
  const auth = createAuth({ DATA_DIR: dir, COOKIE_NAME, ADMIN_COOKIE_NAME, saveJSON() {}, cleanupIntervalMs: 3_600_000 });
  t.after(() => { clearInterval(auth.cleanupTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { profiles: [
    { id: 'admin1', name: 'Admin', username: 'boss', role: 'admin', password: auth.hashPassword('adminpw'), pin: '' },
    { id: 'kid1', name: 'Kid', username: 'kid', role: 'user', password: auth.hashPassword('kidpw'), pin: auth.hashPassword('1234'), permissions: ['canNotify'] },
  ] };
  const profileData = new Map(); const logins = []; let configSaves = 0;
  const removedFiles = [];
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  register(app, {
    ...auth, getConfig: () => config, saveConfig: () => configSaves++,
    loadProfileData: id => profileData.get(id) || { quality: undefined },
    saveProfileData: (id, d) => profileData.set(id, d),
    profileDataCache: profileData, profileDataPath: id => path.join(dir, `missing-${id}.json`),
    removeFile: p => removedFiles.push(p),
    recordLogin: entry => logins.push(entry),
    COOKIE_NAME, ADMIN_COOKIE_NAME, COOKIE_SECURE: false,
    LOGIN_RATE_WINDOW_MS: 300000, LOGIN_MAX_ATTEMPTS: maxAttempts,
    isQualityPreset: q => Object.hasOwn({ low: {}, auto: {}, high: {} }, q), castHost, port: 4800,
    networkInterfaces: () => ({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }] }),
    log() {},
  });

  async function call(method, route, { body = {}, params = {}, cookie = '', ip = '10.0.0.1', query = {} } = {}) {
    const req = { method, body, params, query, ip, headers: cookie ? { cookie } : {} };
    const res = { statusCode: 200, cookies: {}, cleared: [],
      status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; },
      cookie(name, value, opts) { this.cookies[name] = { value, opts }; return this; }, clearCookie(name) { this.cleared.push(name); return this; } };
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `${method} ${route} is registered`);
    for (const h of handlers) {
      let advanced = false;
      await h(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
    return res;
  }
  async function login(username, password, ip) {
    const res = await call('post', '/api/login', { body: { username, password }, ip });
    const cookie = res.cookies[COOKIE_NAME] ? `${COOKIE_NAME}=${res.cookies[COOKIE_NAME].value}` : '';
    return { res, cookie };
  }
  return { auth, config, call, login, logins, profileData, removedFiles, get configSaves() { return configSaves; } };
}

test('a correct password signs in with the right cookies and records the login', async t => {
  const f = fixture(t);
  const { res, cookie } = await f.login('BOSS', 'adminpw');
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ ...res.body, permissions: res.body.permissions.length > 0 }, { ok: true, role: 'admin', profileId: 'admin1', name: 'Admin', permissions: true });
  assert.equal(res.cookies[COOKIE_NAME].opts.httpOnly, true);
  assert.equal(res.cookies[COOKIE_NAME].opts.sameSite, 'strict');
  assert.ok(res.cookies[ADMIN_COOKIE_NAME], 'admins also get the admin token');
  assert.deepEqual(f.logins.at(-1), { profileName: 'Admin', username: 'BOSS', ip: '10.0.0.1', success: true });
  const me = await f.call('get', '/api/me', { cookie });
  assert.equal(me.body.loggedIn, true);
  assert.equal(me.body.quality, 'auto');
  const userOnly = fixture(t);
  userOnly.config.profiles[1].permissions = [];
  assert.equal((await userOnly.login('kid', 'kidpw')).res.cookies[ADMIN_COOKIE_NAME], undefined, 'no permissions, no admin token');
});

test('wrong or unknown credentials get the same answer and the limit is per address and name', async t => {
  const f = fixture(t, { maxAttempts: 3 });
  const unknown = await f.login('nobody', 'x');
  const wrong = await f.login('kid', 'nope');
  assert.equal(unknown.res.statusCode, 403);
  assert.deepEqual(unknown.res.body, wrong.res.body);
  assert.deepEqual(f.logins.map(l => l.reason), ['Unknown user', 'Wrong password']);
  await f.login('kid', 'nope'); await f.login('kid', 'nope');
  const limited = await f.login('kid', 'kidpw');
  assert.equal(limited.res.statusCode, 429);
  assert.equal(f.logins.at(-1).reason, 'Rate limited');
  assert.equal((await f.login('kid', 'kidpw', '10.0.0.2')).res.statusCode, 200, 'another address is unaffected');
  assert.equal((await f.login('boss', 'adminpw')).res.statusCode, 200, 'another name from the same address is unaffected');
});

test('a successful login clears earlier failures', async t => {
  const f = fixture(t, { maxAttempts: 3 });
  await f.login('kid', 'nope'); await f.login('kid', 'nope');
  assert.equal((await f.login('kid', 'kidpw')).res.statusCode, 200);
  await f.login('kid', 'nope'); await f.login('kid', 'nope');
  assert.equal((await f.login('kid', 'kidpw')).res.statusCode, 200);
});

test('logout ends the session and clears both cookies', async t => {
  const f = fixture(t);
  const { cookie } = await f.login('kid', 'kidpw');
  const out = await f.call('post', '/api/logout', { cookie });
  assert.deepEqual(out.cleared, [COOKIE_NAME, ADMIN_COOKIE_NAME]);
  assert.deepEqual((await f.call('get', '/api/me', { cookie })).body, { loggedIn: false });
});

test('quality accepts only real presets', async t => {
  const f = fixture(t);
  const { cookie } = await f.login('kid', 'kidpw');
  assert.equal((await f.call('put', '/api/me/quality', { cookie, body: { quality: 'constructor' } })).statusCode, 400);
  assert.deepEqual((await f.call('put', '/api/me/quality', { cookie, body: { quality: 'low' } })).body, { ok: true, quality: 'low' });
  assert.equal(f.profileData.get('kid1').quality, 'low');
  assert.equal((await f.call('put', '/api/me/quality', { body: { quality: 'low' } })).statusCode, 401);
});

test('cast tokens carry the session and server-info prefers the configured host', async t => {
  const f = fixture(t);
  const { cookie } = await f.login('kid', 'kidpw');
  const { token } = (await f.call('post', '/api/cast-token', { cookie })).body;
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(f.auth.castTokens.get(token).profileId, 'kid1');
  assert.deepEqual((await f.call('get', '/api/server-info', { cookie })).body, { lanHost: '192.168.1.5', port: 4800 });
  const fixed = fixture(t, { castHost: 'tv.lan' });
  const c2 = (await fixed.login('kid', 'kidpw')).cookie;
  assert.deepEqual((await fixed.call('get', '/api/server-info', { cookie: c2 })).body, { lanHost: 'tv.lan', port: 4800 });
});

test('only admins manage profiles; new profiles hash secrets and keep valid permissions', async t => {
  const f = fixture(t);
  const kid = (await f.login('kid', 'kidpw')).cookie;
  const admin = (await f.login('boss', 'adminpw')).cookie;
  assert.equal((await f.call('post', '/api/profiles', { cookie: kid, body: { name: 'X' } })).statusCode, 403);
  assert.equal((await f.call('post', '/api/profiles', { cookie: admin, body: {} })).statusCode, 400);
  assert.equal((await f.call('post', '/api/profiles', { cookie: admin, body: { name: 'Other', username: 'KID' } })).body.error, 'Username already taken');
  const made = await f.call('post', '/api/profiles', { cookie: admin, body: { name: 'Gran Ma!', password: 'pw', pin: '9', permissions: ['canLogs', 'bogus'] } });
  assert.equal(made.body.profile.username, 'granma');
  assert.deepEqual(made.body.profile.permissions, ['canLogs']);
  const stored = f.config.profiles.at(-1);
  assert.notEqual(stored.password, 'pw');
  assert.equal(f.auth.verifyPassword('pw', stored.password), true);
  assert.equal(f.auth.verifyPassword('9', stored.pin), true);
  assert.equal(stored._notifyMigrated, true);
  assert.equal(f.configSaves, 1);
});

test('changing who a profile is signs out its other sessions but not the editor', async t => {
  const f = fixture(t);
  const kid = (await f.login('kid', 'kidpw')).cookie;
  const admin = (await f.login('boss', 'adminpw')).cookie;
  assert.deepEqual((await f.call('put', '/api/profiles/:id', { cookie: admin, params: { id: 'kid1' }, body: { name: 'Kiddo' } })).body, { ok: true });
  assert.equal((await f.call('get', '/api/me', { cookie: kid })).body.loggedIn, true, 'a rename keeps the session');
  await f.call('put', '/api/profiles/:id', { cookie: admin, params: { id: 'kid1' }, body: { permissions: ['canLogs', 'nope'] } });
  assert.deepEqual(f.config.profiles[1].permissions, ['canLogs']);
  assert.equal((await f.call('get', '/api/me', { cookie: kid })).body.loggedIn, false, 'a permission change signs the profile out');
  await f.call('put', '/api/profiles/:id', { cookie: admin, params: { id: 'admin1' }, body: { password: 'new' } });
  assert.equal((await f.call('get', '/api/me', { cookie: admin })).body.loggedIn, true, 'the editor keeps their own session');
  assert.equal((await f.call('put', '/api/profiles/:id', { cookie: admin, params: { id: 'admin1' }, body: { username: 'KID' } })).statusCode, 400);
  assert.equal((await f.call('put', '/api/profiles/:id', { cookie: admin, params: { id: 'zzz' }, body: {} })).statusCode, 404);
});

test('deleting a profile signs it out and drops its data, but never the last profile', async t => {
  const f = fixture(t);
  const kid = (await f.login('kid', 'kidpw')).cookie;
  const admin = (await f.login('boss', 'adminpw')).cookie;
  f.profileData.set('kid1', { quality: 'low' });
  assert.deepEqual((await f.call('delete', '/api/profiles/:id', { cookie: admin, params: { id: 'kid1' } })).body, { ok: true });
  assert.deepEqual(f.config.profiles.map(p => p.id), ['admin1']);
  assert.equal(f.profileData.has('kid1'), false);
  assert.equal((await f.call('get', '/api/me', { cookie: kid })).body.loggedIn, false);
  assert.equal((await f.call('delete', '/api/profiles/:id', { cookie: admin, params: { id: 'admin1' } })).statusCode, 400);
});

test('PIN checks pass profiles without a PIN and are rate limited per address', async t => {
  const f = fixture(t, { maxAttempts: 2 });
  const kid = (await f.login('kid', 'kidpw')).cookie;
  const pin = (id, value, ip) => f.call('post', '/api/profiles/:id/verify-pin', { cookie: kid, params: { id }, body: { pin: value }, ip });
  assert.deepEqual((await pin('admin1', '')).body, { ok: true });
  assert.equal((await pin('nope', '1')).statusCode, 404);
  assert.deepEqual((await pin('kid1', '1234')).body, { ok: true });
  assert.equal((await pin('kid1', '0000')).statusCode, 403);
  assert.equal((await pin('kid1', '0000')).statusCode, 403);
  assert.equal((await pin('kid1', '1234')).statusCode, 429);
  assert.deepEqual((await pin('kid1', '1234', '10.9.9.9')).body, { ok: true });
});
