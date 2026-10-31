const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('./activity');

test('GET /api/activity needs "Who\'s on" and returns the snapshot', async () => {
  const routes = new Map();
  const app = { get: (route, ...h) => routes.set(`get ${route}`, h) };
  const snapshot = { counts: { online: 1, watching: 0, listening: 1 }, people: [{ name: 'Kyle', doing: 'listening' }], busy: [] };
  register(app, { requirePermission: name => Object.assign(() => {}, { permission: name }), activity: { snapshot: async () => snapshot } });
  const handlers = routes.get('get /api/activity');
  assert.equal(handlers[0].permission, 'canActivity');
  const res = { json(v) { this.body = v; return this; } };
  await handlers.at(-1)({}, res);
  assert.deepEqual(res.body, snapshot);
});
