const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeCrash, MAX } = require('./crash-report');

test('errors report their stack, other values report themselves', () => {
  const error = new Error('boom');
  assert.match(describeCrash(error), /^Error: boom/);
  assert.equal(describeCrash('plain string'), 'plain string');
  assert.equal(describeCrash(undefined), 'undefined');
  assert.equal(describeCrash(null), 'null');
  assert.equal(describeCrash({ code: 'ENOENT' }), '{"code":"ENOENT"}');
});

test('a reporter must never throw while reporting a crash', () => {
  const hostile = {}; Object.defineProperty(hostile, 'x', { get() { throw new Error('nope'); }, enumerable: true });
  assert.equal(describeCrash(hostile), '[unprintable rejection value]');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(describeCrash(cyclic), '[unprintable rejection value]');
  const noStack = new Error('bare'); delete noStack.stack;
  assert.match(describeCrash(noStack), /Error: bare/);
});

test('output is bounded and free of control characters', () => {
  assert.equal(describeCrash('a'.repeat(MAX + 500)).length, MAX + '… (truncated)'.length);
  assert.equal(describeCrash('one\u0000two\u0007three'), 'one two three');
  // Newlines survive: a stack trace is unreadable without them.
  assert.equal(describeCrash('line1\nline2'), 'line1\nline2');
});
