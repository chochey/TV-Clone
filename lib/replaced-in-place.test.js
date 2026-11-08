const test = require('node:test');
const assert = require('node:assert/strict');
const { replacedInPlace, forgetProbeResults } = require('./replaced-in-place');

// Interstellar (2014): a 4K AV1 file replaced by a 1080p H.264 copy under the same name (2026-11-08).
const before = { _filePath: '/m/Interstellar (2014)/Interstellar (2014).mkv', fileSize: 18116220051, addedAt: 1785100000000 };

test('a file with a new size or modification time under the same name was replaced in place', () => {
  assert.equal(replacedInPlace(before, 9100000000, 1794200000000), true);
  assert.equal(replacedInPlace(before, 18116220051, 1794200000000), true, 'same size, rewritten');
  assert.equal(replacedInPlace(before, 9100000000, 1785100000000), true, 'new size, old time');
  assert.equal(replacedInPlace(before, 18116220051, 1785100000000), false, 'untouched');
  assert.equal(replacedInPlace(undefined, 1, 1), false, 'a new file is probed anyway');
});

test('forgetting a replaced file clears every probe cache for that path and nothing else', () => {
  const path = before._filePath, other = '/m/Heat (1995)/Heat (1995).mkv';
  const probe = Object.assign(Object.create(null), { [path]: 'av1', [other]: 'h264' });
  const pixFmt = { [path]: 'yuv420p10le', [other]: 'yuv420p' }, height = { [path]: 2160 }, empty = {};
  assert.equal(forgetProbeResults([probe, pixFmt, height, empty], path), true);
  assert.deepEqual({ ...probe }, { [other]: 'h264' });
  assert.deepEqual(pixFmt, { [other]: 'yuv420p' });
  assert.deepEqual(height, {});
  assert.equal(forgetProbeResults([probe, pixFmt, height], path), false, 'nothing left to forget');
});
