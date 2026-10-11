import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuePreview, filterContinue } from './continue-preview.js';

test('home previews the twelve most recent titles across watching and listening without mutating its source', () => {
  const items = Array.from({ length: 18 }, (_, index) => ({ id: String(index), mediaKind: index % 2 ? 'audio' : 'movie', progress: { updatedAt: index } }));
  const preview = continuePreview(items);
  assert.equal(preview.watching.length + preview.listening.length, 12); assert.equal(preview.hasMore, true);
  assert.deepEqual(preview.recent.map(item => item.id), [...items].reverse().map(item => item.id));
  assert.equal(items[0].id, '0');
  assert.equal(filterContinue(preview.recent, 'listening').length, 9);
  assert.equal(filterContinue(preview.recent, 'watching').length, 9);
  assert.equal(filterContinue(preview.recent, 'all').length, 18);
});
