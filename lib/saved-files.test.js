const test = require('node:test');
const assert = require('node:assert/strict');
const createSavedFilesLog = require('./saved-files');

test('a saved file is logged with who, what, how big, from where, and whether it finished', () => {
  const pushed = [];
  const log = createSavedFilesLog({
    ring: { push: e => pushed.push(e) },
    getSession: req => req.session,
    profiles: () => [{ id: 'kyle', name: 'Kyle' }],
    titleFor: id => (id === 'film' ? 'Heat' : null),
    sizeOf: f => { if (f.includes('gone')) throw new Error('ENOENT'); return 4_300_000_000; },
  });
  log.record({ req: { session: { profileId: 'kyle' }, ip: '10.0.0.247' }, id: 'film', filePath: '/m/Heat (1995)/Heat (1995).mkv', completed: true, ms: 95_400, range: false });
  log.record({ req: { session: null, ip: '1.2.3.4' }, id: 'other', filePath: '/m/gone/Old.mp4', completed: false, ms: 3_000, range: true });
  assert.deepEqual(pushed, [
    { profileName: 'Kyle', id: 'film', title: 'Heat', file: 'Heat (1995).mkv', bytes: 4_300_000_000, ip: '10.0.0.247', completed: true, seconds: 95, partial: false, requests: 1 },
    { profileName: null, id: 'other', title: 'Old.mp4', file: 'Old.mp4', bytes: null, ip: '1.2.3.4', completed: false, seconds: 3, partial: true, requests: 1 },
  ]);
});

test('a caller can name what was saved when it is not a library title', () => {
  const pushed = [];
  const log = createSavedFilesLog({ ring: { push: e => pushed.push(e) }, getSession: () => null, profiles: () => [], titleFor: () => null, sizeOf: () => 10 });
  log.record({ req: { ip: '10.0.0.9' }, id: 'riftwarden-launcher', filePath: '/x/RiftWardenLauncher.exe', completed: true, ms: 1000, title: 'Rift Warden launcher' });
  assert.equal(pushed[0].title, 'Rift Warden launcher');
  assert.equal(pushed[0].file, 'RiftWardenLauncher.exe');
});

test('repeat requests from one person for the same file become one row, so nobody can flood the log', () => {
  let clock = 1_000_000;
  const entries = []; let touched = 0;
  const ring = { entries, push: e => entries.unshift({ timestamp: clock, ...e }), touch: () => { touched++; } };
  const log = createSavedFilesLog({ ring, getSession: req => req.session, profiles: () => [{ id: 'kyle', name: 'Kyle' }],
    titleFor: () => 'Heat', sizeOf: () => 100, now: () => clock });
  const req = { session: { profileId: 'kyle' }, ip: '10.0.0.247' };
  log.record({ req, id: 'film', filePath: '/m/Heat.mkv', completed: false, ms: 4000, range: false });
  clock += 60_000;
  log.record({ req, id: 'film', filePath: '/m/Heat.mkv', completed: true, ms: 90_000, range: true });   // a resumed download
  for (let i = 0; i < 50; i++) log.record({ req, id: 'film', filePath: '/m/Heat.mkv', completed: true, ms: 1, range: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].completed, true, 'finished once any request finished');
  assert.equal(entries[0].requests, 52);
  assert.ok(touched >= 51);
  log.record({ req, id: 'other', filePath: '/m/Other.mkv', completed: true, ms: 1000 });
  assert.equal(entries.length, 2, 'a different file is its own row');
  clock += 11 * 60_000;
  log.record({ req, id: 'film', filePath: '/m/Heat.mkv', completed: true, ms: 1000 });
  assert.equal(entries.length, 3, 'the same file again much later is a new row');
});
