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
    { profileName: 'Kyle', id: 'film', title: 'Heat', file: 'Heat (1995).mkv', bytes: 4_300_000_000, ip: '10.0.0.247', completed: true, seconds: 95, partial: false },
    { profileName: null, id: 'other', title: 'Old.mp4', file: 'Old.mp4', bytes: null, ip: '1.2.3.4', completed: false, seconds: 3, partial: true },
  ]);
});
