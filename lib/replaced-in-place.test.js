const test = require('node:test');
const assert = require('node:assert/strict');
const { replacedInPlace, forgetProbeResults, shelfDate, fileMtime } = require('./replaced-in-place');

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

// Interstellar and Jurassic World Rebirth led "Fresh on your shelf" as "Added today" after their HDR
// copies were swapped in (2026-11-09): the date a title joined the shelf was the file's modification time.
test('a replaced file keeps the date it joined the shelf, and its new time is still noticed', () => {
  assert.equal(shelfDate(before, 1794200000000), 1785100000000, 'the swap does not make it new');
  assert.equal(shelfDate(undefined, 1794200000000), 1794200000000, 'a new file is as new as its time');
  assert.equal(shelfDate(before, 1700000000000), 1700000000000, 'an older file time is the earlier date');
  const after = { ...before, fileSize: 6540380591, addedAt: 1785100000000, fileMtime: 1794200000000 };
  assert.equal(fileMtime(after), 1794200000000);
  assert.equal(fileMtime(before), 1785100000000, 'items saved before the split used one field for both');
  assert.equal(replacedInPlace(after, 6540380591, 1794200000000), false, 'the same copy on the next scan');
  assert.equal(replacedInPlace(after, 6540380591, 1794300000000), true, 'rewritten again');
  assert.equal(shelfDate(after, 1794300000000), 1785100000000);
});
