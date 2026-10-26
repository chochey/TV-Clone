// The watchdog used to run from a timer every minute and log four lines each time, all of them "OK":
// ~7,000 journal lines a day saying nothing. As a loop it prints only what is worth reading.
const test = require('node:test');
const assert = require('node:assert/strict');
const { worthPrinting } = require('./watchdog-quiet');

const fine = { ok: true, results: [{ step: 'clean-stale-transcodes', ok: true, count: 0 }] };

test('the first pass is printed once, then nothing while everything stays fine', () => {
  assert.equal(worthPrinting(null, fine), true);
  assert.equal(worthPrinting(fine, fine), false);
});

test('a problem is printed, and so is the recovery from it', () => {
  const broken = { ok: false, results: [{ step: 'app', ok: false, message: 'not answering' }] };
  assert.equal(worthPrinting(fine, broken), true);
  assert.equal(worthPrinting(broken, broken), true, 'still broken: keep saying so');
  assert.equal(worthPrinting(broken, fine), true, 'back to normal: say it once');
});

test('a pass that did something (cleaned stale transcodes) is printed even though all is fine', () => {
  const cleaned = { ok: true, results: [{ step: 'clean-stale-transcodes', ok: true, count: 2 }] };
  assert.equal(worthPrinting(fine, cleaned), true);
});
