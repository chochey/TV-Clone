const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewCorrupted, RECHECK_AFTER_MS } = require('./corrupted-registry');

const day = 86400000, now = 1794200000000;
// November 2026: 25 entries, 19 for titles no longer in the library; the 6 left all probed and decoded fine.
test('entries for titles gone from the library are forgotten, old ones are tried again, recent ones stay', () => {
  const entries = {
    gone: { detectedAt: now - 2 * day, reason: 'no frames extracted' },
    old: { detectedAt: now - 200 * day, reason: 'ffprobe spawn error' },
    edge: { detectedAt: now - RECHECK_AFTER_MS, reason: 'no frames extracted' },
    recent: { detectedAt: now - 3 * day, reason: 'no frames extracted' },
    undated: { reason: 'no frames extracted' },
  };
  const library = new Set(['old', 'edge', 'recent', 'undated']);
  assert.deepEqual(reviewCorrupted(entries, library, now), { forget: ['gone'], recheck: ['old', 'edge', 'undated'] });
  assert.equal(RECHECK_AFTER_MS, 14 * day);
});

test('an empty library forgets nothing: a scan that found no files is not proof they are gone', () => {
  const entries = { a: { detectedAt: now }, b: { detectedAt: now - 30 * day } };
  assert.deepEqual(reviewCorrupted(entries, new Set(), now), { forget: [], recheck: [] });
});
