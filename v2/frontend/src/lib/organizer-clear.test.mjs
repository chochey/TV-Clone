import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeClearResult, leftoverSummary } from './organizer-clear.js';

test('says how many files and folders were cleared', () => {
  assert.equal(describeClearResult({ cleared: [{ name: 'A', files: 3, folderRemoved: true }, { name: 'B', files: 2, folderRemoved: true }], skipped: [] }),
    'Removed 5 leftover files from 2 folders.');
  assert.equal(describeClearResult({ cleared: [{ name: 'A', files: 1, folderRemoved: true }], skipped: [] }),
    'Removed 1 leftover file from 1 folder.');
});

test('says what was left alone and why that is not an error', () => {
  assert.equal(describeClearResult({ cleared: [{ name: 'A', files: 2, folderRemoved: true }], skipped: [{ name: 'B', reason: 'x' }] }),
    'Removed 2 leftover files from 1 folder. 1 was left alone because it changed.');
  assert.equal(describeClearResult({ cleared: [], skipped: [{ name: 'A' }, { name: 'B' }] }),
    'Nothing was removed. 2 were left alone because they changed.');
});

test('a reply with nothing in it is handled', () => {
  assert.equal(describeClearResult({}), 'Nothing was removed.');
  assert.equal(describeClearResult(null), 'Nothing was removed.');
});

test('the confirmation says what will happen without scaring about media', () => {
  assert.equal(leftoverSummary([{ name: 'A' }]), 'Delete the leftover text, image and link files from 1 folder? The imported movies and episodes are not touched.');
  assert.equal(leftoverSummary([{ name: 'A' }, { name: 'B' }]), 'Delete the leftover text, image and link files from 2 folders? The imported movies and episodes are not touched.');
});
