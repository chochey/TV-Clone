// Run with: node --test lib/subtitles.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { srtToVtt } = require('./subtitles');
const { EventEmitter } = require('events');
const createSubtitles = require('./subtitles');

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

class SubtitleResponse extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.headersSent = false; this.statusCode = 200; }
  set() { return this; }
  status(code) { this.statusCode = code; return this; }
  send(body) { this.body = body; this.headersSent = true; return this; }
  end(body) { this.send(body); }
  disconnect() { this.destroyed = true; this.emit('close'); }
}
function extractionHarness() {
  const jobs = [], written = [];
  const runner = { run: (_command, _args, options) => new Promise((resolve, reject) => {
    jobs.push({ resolve, reject, options });
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' })), { once: true });
  }) };
  const subtitles = createSubtitles({ SUBTITLE_CACHE_DIR: '/cache', runner,
    io: { existsSync: file => file === '/sample.mkv', promises: {
      writeFile: async (_file, data) => written.push(data), rename: async () => {}, unlink: async () => {},
    } },
  });
  const request = res => subtitles.serveEmbedded({ filePath: '/sample.mkv', fileId: 'sample', streamIdx: 2,
    knownSubs: [{ index: 2, extractable: true }] }, res);
  return { jobs, written, request };
}

test('simultaneous subtitle requests share extraction and one disconnect does not cancel another viewer', async () => {
  const h = extractionHarness(), first = new SubtitleResponse(), second = new SubtitleResponse();
  const work = [h.request(first), h.request(second)]; assert.equal(h.jobs.length, 1);
  first.disconnect(); assert.equal(h.jobs[0].options.signal.aborted, false);
  h.jobs[0].resolve({ stdout: Buffer.from('WEBVTT\n\nCaption'), stderr: '' }); await Promise.all(work);
  assert.equal(first.body, undefined); assert.equal(second.body.toString(), 'WEBVTT\n\nCaption');
  assert.equal(h.written.length, 1);
});

test('last subtitle disconnect cancels work; a later request can retry', async () => {
  const h = extractionHarness(), first = new SubtitleResponse();
  const work = h.request(first); first.disconnect(); await work;
  assert.equal(h.jobs[0].options.signal.aborted, true); assert.equal(h.written.length, 0);
  const retry = new SubtitleResponse(), next = h.request(retry); assert.equal(h.jobs.length, 2);
  h.jobs[1].resolve({ stdout: Buffer.from('WEBVTT'), stderr: '' }); await next;
  assert.equal(retry.statusCode, 200);
});

test('extraction deadline/output failure returns a visible retryable error', async () => {
  const h = extractionHarness(), res = new SubtitleResponse(), work = h.request(res);
  h.jobs[0].reject(Object.assign(new Error('Output limit'), { code: 'MEDIA_OUTPUT_LIMIT' })); await work;
  assert.equal(res.statusCode, 503); assert.match(res.body, /try again/i); assert.equal(h.written.length, 0);
});
