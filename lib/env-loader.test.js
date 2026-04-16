// Run with: node --test lib/env-loader.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLine } = require('./env-loader');

test('simple KEY=value', () => {
  assert.deepEqual(parseLine('FOO=bar'), { key: 'FOO', value: 'bar' });
});

test('whitespace around equals', () => {
  assert.deepEqual(parseLine('FOO = bar'), { key: 'FOO', value: 'bar' });
});

test('double-quoted value preserves spaces', () => {
  assert.deepEqual(parseLine('GREETING="hello world"'), { key: 'GREETING', value: 'hello world' });
});

test('double-quoted value preserves = signs (the bug from the old parser)', () => {
  assert.deepEqual(parseLine('URL="https://example.com/?a=1&b=2"'), { key: 'URL', value: 'https://example.com/?a=1&b=2' });
});

test('single-quoted value', () => {
  assert.deepEqual(parseLine("NAME='Alice'"), { key: 'NAME', value: 'Alice' });
});

test('export prefix is stripped', () => {
  assert.deepEqual(parseLine('export PATH=/usr/local/bin'), { key: 'PATH', value: '/usr/local/bin' });
});

test('inline # comment on unquoted value is stripped', () => {
  assert.deepEqual(parseLine('DEBUG=1 # enable debug'), { key: 'DEBUG', value: '1' });
});

test('# inside quoted value is preserved', () => {
  assert.deepEqual(parseLine('COLOR="#ff00aa"'), { key: 'COLOR', value: '#ff00aa' });
});

test('line that is not KEY=VALUE returns null', () => {
  assert.equal(parseLine('just some text'), null);
});

test('invalid identifier (starts with digit) returns null', () => {
  assert.equal(parseLine('1FOO=bar'), null);
});

test('empty value', () => {
  assert.deepEqual(parseLine('EMPTY='), { key: 'EMPTY', value: '' });
});

test('unterminated quote returns null', () => {
  assert.equal(parseLine('BROKEN="unclosed'), null);
});
