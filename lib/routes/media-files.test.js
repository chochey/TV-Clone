const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./media-files');

// Saving the original file is a permission of its own ("Save files"), separate from watching.
function fixture() {
  const routes = new Map(); const guards = [];
  const app = Object.fromEntries(['get', 'post'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  const requirePermission = name => { const g = function guard() {}; g.permission = name; guards.push(name); return g; };
  const files = { film: '/library/Movies/Heat (1995)/Heat (1995).mkv', book: '/library/Books/A Book/A Book.m4b' };
  register(app, {
    requireAuth() {}, ensureLibrary() {}, requirePermission,
    fileFor: id => files[id], posterFor: () => null, playbackIssueForFile: () => '', isAudioFile: f => /\.m4b$/.test(f || ''),
    audiobookFile: id => id === 'book', audioLite: {}, audioMetadata: {}, backdrop: {}, streamMediaFile: async () => {}, recordError() {},
  });
  async function call(key, params) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, send(v) { this.body = v; return this; }, json(v) { this.body = v; return this; },
      download(file, name) { this.downloaded = { file, name }; return this; } };
    await routes.get(key).at(-1)({ params }, res);
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
