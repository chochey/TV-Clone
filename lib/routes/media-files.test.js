const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const register = require('./media-files');

// Saving the original file is a permission of its own ("Save files"), separate from watching.
function fixture({ onSaved } = {}) {
  const routes = new Map(); const guards = [];
  const app = Object.fromEntries(['get', 'post'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const requirePermission = name => { const g = function guard() {}; g.permission = name; guards.push(name); return g; };
  const files = { film: '/library/Movies/Heat (1995)/Heat (1995).mkv', book: '/library/Books/A Book/A Book.m4b' };
  register(app, {
    requireAuth() {}, ensureLibrary() {}, requirePermission,
    fileFor: id => files[id], posterFor: () => null, playbackIssueForFile: () => '', isAudioFile: f => /\.m4b$/.test(f || ''),
    audiobookFile: id => id === 'book', audioLite: {}, audioMetadata: {}, backdrop: {}, streamMediaFile: async () => {}, recordError() {},
    ...(onSaved ? { onSaved } : {}),
  });
  async function call(key, params, { headers = {}, method = 'GET' } = {}) {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false, status(c) { this.statusCode = c; return this; }, send(v) { this.body = v; return this; }, json(v) { this.body = v; return this; },
      sendStatus(c) { this.statusCode = c; this.ended = true; return this; },
      download(file, name, cb) { this.downloaded = { file, name }; this.done = cb; return this; } });
    const req = { params, headers, method, ip: '10.0.0.5' };
    res.req = req;
    await routes.get(key).at(-1)(req, res);
    return res;
  }
  return { routes, call, guards };
}

test('downloading the original file needs the Save files permission and names the file', async () => {
  const f = fixture();
  const chain = f.routes.get('get /api/download/:id');
  assert.ok(chain, 'route is registered');
  assert.equal(chain[0].permission, 'canSaveMedia');
  assert.equal((await f.call('get /api/download/:id', { id: 'nope' })).statusCode, 404);
  const film = await f.call('get /api/download/:id', { id: 'film' });
  assert.deepEqual(film.downloaded, { file: '/library/Movies/Heat (1995)/Heat (1995).mkv', name: 'Heat (1995).mkv' });
  const book = await f.call('get /api/download/:id', { id: 'book' });
  assert.equal(book.downloaded.name, 'A Book.m4b');
});

test('each saved file is reported once: finished, or stopped when the connection closes first', async () => {
  const saved = [];
  const f = fixture({ onSaved: s => saved.push({ id: s.id, filePath: s.filePath, completed: s.completed, range: s.range, ip: s.req.ip, ms: typeof s.ms }) });
  const whole = await f.call('get /api/download/:id', { id: 'film' });
  whole.emit('finish'); whole.emit('close');
  const cut = await f.call('get /api/download/:id', { id: 'book' }, { headers: { range: 'bytes=0-' } });
  cut.emit('close');
  const failed = await f.call('get /api/download/:id', { id: 'film' });
  failed.done(new Error('ECONNABORTED')); failed.emit('close');
  assert.deepEqual(saved, [
    { id: 'film', filePath: '/library/Movies/Heat (1995)/Heat (1995).mkv', completed: true, range: false, ip: '10.0.0.5', ms: 'number' },
    { id: 'book', filePath: '/library/Books/A Book/A Book.m4b', completed: false, range: true, ip: '10.0.0.5', ms: 'number' },
    { id: 'film', filePath: '/library/Movies/Heat (1995)/Heat (1995).mkv', completed: false, range: false, ip: '10.0.0.5', ms: 'number' },
  ]);
  await f.call('get /api/download/:id', { id: 'nope' });
  assert.equal(saved.length, 3, 'a missing file is not a saved file');
});

test('a name that only exists on every JavaScript object is not a file, and the log never throws later', async () => {
  const saved = [];
  const f = fixture({ onSaved: s => saved.push(s.id) });
  // fileFor reads a plain object, so "constructor" would come back as a function, not a path.
  for (const id of ['constructor', 'toString', '__proto__']) {
    const res = await f.call('get /api/download/:id', { id });
    assert.equal(res.statusCode, 404, id);
  }
  const res = await f.call('get /api/download/:id', { id: 'film' });
  res.req.params = undefined;   // Express resets req.params once the handler is done
  assert.doesNotThrow(() => res.emit('finish'));
  assert.deepEqual(saved, ['film']);
});

test('a library file that vanished from disk answers 404 instead of leaving the download hanging', async () => {
  const f = fixture();
  const res = await f.call('get /api/download/:id', { id: 'film' });
  res.done(Object.assign(new Error('ENOENT'), { status: 404 }));
  assert.equal(res.statusCode, 404);
  assert.equal(res.ended, true);
});

test('a HEAD request (a browser or tool asking only for the size) is not logged as a saved file', async () => {
  const saved = [];
  const f = fixture({ onSaved: s => saved.push(s.id) });
  const res = await f.call('get /api/download/:id', { id: 'film' }, { method: 'HEAD' });
  res.emit('finish');
  assert.deepEqual(saved, []);
});
