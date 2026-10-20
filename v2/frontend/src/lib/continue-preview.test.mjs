import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuePreview, filterContinue } from './continue-preview.js';

test('home previews the most recent titles as one row of films, series and audiobooks, without mutating its source', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ id: String(index), mediaKind: index % 2 ? 'audio' : 'movie', progress: { updatedAt: index } }));
  const preview = continuePreview(items);
  assert.equal(preview.row.length, 18, 'eighteen fill a 2K screen with a little to scroll');
  assert.deepEqual(preview.row.slice(0, 3).map(item => item.id), ['19', '18', '17'], 'newest first, kinds mixed');
  assert.equal(preview.watching.length + preview.listening.length, 18); assert.equal(preview.hasMore, true);
  assert.equal(continuePreview(items, 12).row.length, 12);
  assert.deepEqual(preview.recent.map(item => item.id), [...items].reverse().map(item => item.id));
  assert.equal(items[0].id, '0');
  assert.equal(filterContinue(preview.recent, 'listening').length, 10);
  assert.equal(filterContinue(preview.recent, 'watching').length, 10);
  assert.equal(filterContinue(preview.recent, 'all').length, 20);
});
