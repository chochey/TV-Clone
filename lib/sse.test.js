const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const createSse = require('./sse');

function client(sse, profileId) {
  const req = Object.assign(new EventEmitter(), { session: profileId ? { profileId } : undefined });
  const res = { writes: [], writeHead() {}, write(s) { this.writes.push(s); }, status() { return this; }, send() {} };
  sse.handler(req, res);
  return { req, res, close: () => req.emit('close') };
}

test('present() counts open live-update streams per profile and forgets closed ones', t => {
  const sse = createSse({ maxClients: 10, heartbeatMs: 60_000 });
  const kyle1 = client(sse, 'kyle'), kyle2 = client(sse, 'kyle'), mom = client(sse, 'mom');
  const anonymous = client(sse, null);   // a cast receiver or similar without a profile is not a person
  t.after(() => [kyle1, kyle2, mom, anonymous].forEach(c => c.close()));
  assert.deepEqual(sse.present(), { kyle: 2, mom: 1 });
  assert.equal(sse.count(), 4);
  kyle1.close(); mom.close();
  assert.deepEqual(sse.present(), { kyle: 1 });
  sse.notify('library-updated', { a: 1 });
  assert.match(kyle2.res.writes.at(-1), /^event: library-updated\ndata: {"a":1}/);
});
