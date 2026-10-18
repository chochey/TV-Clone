import test from 'node:test';
import assert from 'node:assert/strict';
import { introOffer, upNext, UPNEXT_LEAD, OUTRO_GRACE } from './upnext-timing.js';

test('Skip Intro is offered only inside a usable intro range', () => {
  const intro = { start: 5, end: 60 };
  assert.deepEqual(introOffer({ intro, total: 1800, cur: 10, scrubbing: false }), { valid: true, show: true });
  assert.equal(introOffer({ intro, total: 1800, cur: 59.6, scrubbing: false }).show, false, 'not in the last half second');
  assert.equal(introOffer({ intro, total: 1800, cur: 2, scrubbing: false }).show, false);
  assert.equal(introOffer({ intro, total: 1800, cur: 10, scrubbing: true }).show, false);
  assert.equal(introOffer({ intro: { start: 60, end: 5 }, total: 1800, cur: 10 }).valid, false);
  assert.equal(introOffer({ intro: { start: 0, end: 1799 }, total: 1800, cur: 10 }).valid, false, 'an intro ending at the credits strands the viewer');
  assert.equal(introOffer({ intro, total: 0, cur: 10 }).valid, true, 'unknown length does not block it');
  assert.equal(introOffer({ intro: null, total: 1800, cur: 10 }).valid, false);
});

test('without credit timing the card runs up to the true end', () => {
  const s = upNext({ total: 1800, cur: 1800 - UPNEXT_LEAD, outro: null });
  assert.deepEqual(s, { advanceAt: 1800, secondsLeft: UPNEXT_LEAD, nearEnd: true });
  assert.equal(upNext({ total: 1800, cur: 1700, outro: null }).nearEnd, false);
  assert.equal(upNext({ total: 1800, cur: 1800, outro: null }).nearEnd, false, 'not after the end');
});

test('known credits advance shortly after they start', () => {
  const s = upNext({ total: 1800, cur: 1700, outro: { start: 1650 } });
  assert.equal(s.advanceAt, 1650 + OUTRO_GRACE);
  assert.equal(s.secondsLeft, 0);
  assert.equal(upNext({ total: 1800, cur: 1700, outro: { start: 1900 } }).advanceAt, 1800, 'credits past the end are ignored');
});

test('cancelling, scrubbing, an error or an unknown length hide the card', () => {
  for (const extra of [{ dismissed: true }, { scrubbing: true }, { error: 'x' }, { total: 0 }]) {
    assert.equal(upNext({ total: 1800, cur: 1790, outro: null, ...extra }).nearEnd, false, JSON.stringify(extra));
  }
});
