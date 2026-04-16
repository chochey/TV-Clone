// Run with: node --test lib/subtitles.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { srtToVtt } = require('./subtitles');

test('srtToVtt: adds WEBVTT header', () => {
  assert.match(srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nHello\n'), /^WEBVTT\n\n/);
});

test('srtToVtt: converts SRT comma timestamps to VTT dot timestamps', () => {
  const srt = '1\n00:00:01,500 --> 00:00:02,750\nHello\n';
  const vtt = srtToVtt(srt);
  assert.match(vtt, /00:00:01\.500 --> 00:00:02\.750/);
  assert.doesNotMatch(vtt, /,\d{3}/);
});

test('srtToVtt: normalizes CRLF to LF', () => {
  const vtt = srtToVtt('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n');
  assert.doesNotMatch(vtt, /\r/);
});

test('srtToVtt: strips SSA/ASS style tags', () => {
  const vtt = srtToVtt('{\\an8}Top caption\n');
  assert.doesNotMatch(vtt, /\{\\an8\}/);
  assert.match(vtt, /Top caption/);
});

test('srtToVtt: strips HTML font tags', () => {
  const vtt = srtToVtt('<font color="red">Red text</font>\n');
  assert.doesNotMatch(vtt, /<font|<\/font>/i);
  assert.match(vtt, /Red text/);
});
