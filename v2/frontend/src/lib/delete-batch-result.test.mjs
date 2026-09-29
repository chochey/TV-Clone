import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteBatchResult } from './delete-batch-result.js';
test('partial deletion keeps failed IDs and reports the remaining files and reason', () => {
  const result = deleteBatchResult(['a', 'b', 'c'], { ok: false, deleted: 1, failed: [{ id: 'b', error: 'File in use' }, { id: 'c', error: 'Permission denied' }] });
  assert.deepEqual(result.deletedIds, ['a']); assert.equal(result.failed.length, 2);
  assert.match(result.error, /1 deleted; 2 could not be deleted and remain/); assert.match(result.error, /Permission denied/);
});
test('an HTTP-success response with every deletion failed hides no library items', () => {
  const result = deleteBatchResult(['a'], { ok: false, deleted: 0, failed: [{ id: 'a', error: 'File in use' }] });
  assert.deepEqual(result.deletedIds, []); assert.match(result.error, /0 deleted; 1 could not be deleted/);
});
test('complete deletion confirms all IDs without an error', () => {
  const result = deleteBatchResult(['a', 'b'], { ok: true, deleted: 2, failed: [] });
  assert.deepEqual(result.deletedIds, ['a', 'b']); assert.equal(result.error, '');
});
test('inconsistent responses cannot cause an optimistic removal of unconfirmed IDs', () => {
  assert.throws(() => deleteBatchResult(['a'], { ok: true }), /did not confirm/);
  assert.throws(() => deleteBatchResult(['a'], { deleted: 0, failed: [] }), /did not confirm/);
});
