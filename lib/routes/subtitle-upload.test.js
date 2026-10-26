const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const register = require('./subtitle-upload');

const SRT = '1\r\n00:00:01,000 --> 00:00:04,000\r\nHello there\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,500\r\nGeneral Kenobi\r\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subupload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'Heat (1995).mkv');
  fs.writeFileSync(video, 'video');
  const routes = new Map(); const rescans = [];
  const app = Object.fromEntries(['post'].map(m => [m, (route, ...h) => routes.set(`${m} ${route}`, h)]));
  register(app, {
    requirePermission: () => () => {}, ensureLibrary() {}, textBody: () => {},
    scanLibrary: () => [{ id: 'heat', mediaKind: 'movie' }, { id: 'book', mediaKind: 'audio' }],
    fileFor: id => ({ heat: video, book: path.join(dir, 'b.m4b'), gone: path.join(dir, 'missing.mkv') })[id],
    refreshLibrary: reason => rescans.push(reason), log() {},
  });
  async function upload(id, body, query = { lang: 'eng' }) {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
    await routes.get('post /api/subtitles/:id').at(-1)({ params: { id }, query, body }, res);
    return res;
  }
  return { dir, video, upload, rescans, routes };
}

test('an SRT is saved beside the video with the language and an uploaded tag, then the library refreshes', async t => {
  const f = fixture(t);
  const res = await f.upload('heat', Buffer.from(SRT));
  const file = path.join(f.dir, 'Heat (1995).eng.uploaded.srt');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, label: 'English · Uploaded', filename: 'Heat (1995).eng.uploaded.srt',
    subtitleId: crypto.createHash('sha256').update(file).digest('hex').slice(0, 16), cues: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), SRT.replace(/\r\n/g, '\n'));
  assert.deepEqual(f.rescans, ['subtitle-upload']);
});

test('a second upload never overwrites the first', async t => {
  const f = fixture(t);
  await f.upload('heat', Buffer.from(SRT));
  const second = await f.upload('heat', Buffer.from(SRT));
  assert.equal(second.body.filename, 'Heat (1995).eng.uploaded-2.srt');
  assert.equal(second.body.label, 'English · Uploaded · 2');
});

test('WebVTT is kept as .vtt, a byte-order mark is dropped, and Windows-1252 text becomes UTF-8', async t => {
  const f = fixture(t);
  const vtt = await f.upload('heat', Buffer.from('﻿WEBVTT\n\n00:01.000 --> 00:04.000\nHi\n'), { lang: 'spa' });
  assert.equal(vtt.body.filename, 'Heat (1995).spa.uploaded.vtt');
  assert.equal(fs.readFileSync(path.join(f.dir, vtt.body.filename), 'utf8'), 'WEBVTT\n\n00:01.000 --> 00:04.000\nHi\n');
  const latin = Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf'), Buffer.from([0xe9]), Buffer.from('\n')]);
  const fr = await f.upload('heat', latin, { lang: 'fre' });
  assert.match(fs.readFileSync(path.join(f.dir, fr.body.filename), 'utf8'), /Café/);
});

test('bad requests are refused without writing anything', async t => {
  const f = fixture(t);
  const cases = [
    ['nope', Buffer.from(SRT), { lang: 'eng' }, 404],
    ['gone', Buffer.from(SRT), { lang: 'eng' }, 404],
    ['book', Buffer.from(SRT), { lang: 'eng' }, 415],
    ['heat', Buffer.from(SRT), { lang: '../../etc' }, 400],
    ['heat', Buffer.from(SRT), {}, 400],
    ['heat', Buffer.from('just some text, no timings'), { lang: 'eng' }, 400],
    ['heat', Buffer.alloc(0), { lang: 'eng' }, 400],
    ['heat', 'not a buffer', { lang: 'eng' }, 400],
  ];
  for (const [id, body, query, status] of cases) {
    assert.equal((await f.upload(id, body, query)).statusCode, status, `${id} ${JSON.stringify(query)}`);
  }
  assert.deepEqual(fs.readdirSync(f.dir), ['Heat (1995).mkv']);
  assert.deepEqual(f.rescans, []);
});

test('only admins can upload, and the body parser is limited to this route', t => {
  const f = fixture(t);
  const handlers = f.routes.get('post /api/subtitles/:id');
  assert.equal(handlers.length, 4, 'admin check, library, raw body parser, handler');
});

// Uploading a subtitle is a permission of its own ("Add subtitles"); admins always have it.
test('uploading a subtitle needs the Add subtitles permission', () => {
  const routes = new Map();
  const app = { post: (route, ...h) => routes.set(route, h) };
  register(app, {
    requireAdminSession() {}, requirePermission: name => Object.assign(function guard() {}, { permission: name }),
    ensureLibrary() {}, textBody: () => {}, scanLibrary: () => [], fileFor: () => null, refreshLibrary() {}, log() {},
  });
  assert.equal(routes.get('/api/subtitles/:id')[0].permission, 'canSubtitles');
});
