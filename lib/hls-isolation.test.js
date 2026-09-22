// Exercise the actual registered HLS routes without booting production's
// organizer, conversion worker or media scanners. Only FFmpeg/probes are fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const express = require('express');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const block = source.slice(source.indexOf('const retiredPlaybacks ='), source.indexOf('// ── Server-Sent Events for live updates'));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

async function fixture({ segmentCount = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-isolation-'));
  const media = path.join(root, 'media.mkv'); fs.writeFileSync(media, 'fixture');
  const dir = path.join(root, 'segments'); fs.mkdirSync(dir);
  const app = express(), processes = [];
  let probeGate = null;
  const context = vm.createContext({
    app, fs, path, crypto, URLSearchParams, console: { log() {}, error() {} }, process: { env: {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TRANSCODE_DIR: dir, TRANSCODE_TIMEOUT_MS: 120000, FFMPEG_TRANSCODE_THREADS: 2,
    fileIndex: { film: media }, probeCache: { [media]: 'hevc' }, heightCache: { [media]: 1080 },
    levelCache: { [media]: 120 }, pixFmtCache: { [media]: 'yuv420p10le' },
    audioTracksCache: {}, audioProbeCache: {}, libraryCache: [{ id: 'film', title: 'Fixture' }],
    config: { profiles: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] },
    lastPlaybackAt: 0,
    requireAuth(req, res, next) { req.session = { profileId: req.headers['x-profile'] || 'a' }; next(); },
    ensureLibrary(req, res, next) { next(); },
    probeDurationAsync: async () => { if (probeGate) await probeGate; return 300; },
    probeFileAsync: async () => {}, vaapiAvailable: () => true,
    getStreamMode: () => 'transcode', recordStream() {}, recordError() {},
    buildFfmpegArgs: require('./ffmpeg-args').buildFfmpegArgs,
    spawn(command, args) {
      const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.exitCode = null;
      proc.kill = () => { proc.killed = true; proc.exitCode = 0; proc.emit('close', 0); };
      const output = args.at(-1), seek = args[args.indexOf('-ss') + 1];
      fs.writeFileSync(path.join(path.dirname(output), 'init.mp4'), 'init');
      fs.writeFileSync(path.join(path.dirname(output), 'seg_00000.m4s'), String(seek));
      const segments = Array.from({ length: segmentCount }, (_, i) => `#EXTINF:4,\nseg_${String(i).padStart(5, '0')}.m4s\n`).join('');
      fs.writeFileSync(output, '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n' + segments);
      processes.push(proc); return proc;
    },
  });
  vm.runInContext(block, context);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, profile = 'a', method = 'GET') => {
    const response = await fetch(base + url, { method, signal: AbortSignal.timeout(5000), headers: { 'x-profile': profile } });
    return { status: response.status, body: await response.text(), headers: response.headers };
  };
  const count = () => vm.runInContext('Object.keys(transcodeSessions).length', context);
  return { request, processes, count, gate(promise) { probeGate = promise; },
    async close() { vm.runInContext('Object.keys(transcodeSessions).forEach(id => cleanupSession(id))', context); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); } };
}
const id = n => n.toString(16).padStart(32, '0');
const playlist = (n, start = 0, extra = '') => `/hls/film/${id(n)}/master.m3u8?start=${start}${extra}`;

test('same-title viewers have independent files, seeks, quality, ownership and stops', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(playlist(1, 0))).status, 200);
    assert.equal((await f.request(playlist(2, 80, '&quality=low'), 'b')).status, 200);
    assert.equal(f.processes.length, 2); assert.equal(f.processes[0].killed, undefined);
    assert.equal((await f.request(`/hls/film/${id(2)}/seg_00000.m4s`)).status, 403);
    assert.equal((await f.request(`/api/hls/${id(2)}/stop`, 'a', 'POST')).status, 403);
    assert.equal((await f.request(`/api/hls/${id(1)}/stop`, 'a', 'POST')).status, 200);
    assert.equal(f.processes[0].killed, true); assert.equal(f.processes[1].killed, undefined);
    assert.equal((await f.request(playlist(1))).status, 410, 'late retries cannot resurrect retired streams');
    assert.equal((await f.request(playlist(3, 120))).status, 200);
    assert.equal((await f.request(`/api/hls/${id(2)}/alive`, 'b')).status, 200);
    assert.equal((await f.request(playlist(2, 100), 'b')).status, 409);
    const segment = await f.request(`/hls/film/${id(2)}/seg_00000.m4s`, 'b');
    assert.equal(segment.status, 200); assert.equal(segment.body, '80');
  } finally { await f.close(); }
});

test('pending starts reserve capacity and identical concurrent requests share one encoder', async () => {
  const f = await fixture(), gate = deferred(); f.gate(gate.promise);
  try {
    const a = f.request(playlist(1)), duplicate = f.request(playlist(1)), b = f.request(playlist(2), 'b');
    for (let i = 0; i < 50 && f.count() < 2; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(f.count(), 2);
    assert.equal((await f.request(playlist(3))).status, 503);
    gate.resolve();
    assert.deepEqual((await Promise.all([a, duplicate, b])).map(r => r.status), [200, 200, 200]);
    assert.equal(f.processes.length, 2);
  } finally { gate.resolve(); await f.close(); }
});

test('stopping during probing prevents a late encoder and releases capacity', async () => {
  const f = await fixture(), gate = deferred(); f.gate(gate.promise);
  try {
    const starting = f.request(playlist(1));
    for (let i = 0; i < 50 && !f.count(); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal((await f.request(`/api/hls/${id(1)}/stop`, 'a', 'POST')).status, 200);
    gate.resolve(); assert.equal((await starting).status, 503);
    assert.equal(f.processes.length, 0); assert.equal(f.count(), 0);
    assert.equal((await f.request(playlist(2))).status, 200);
  } finally { gate.resolve(); await f.close(); }
});

test('same-profile tabs are isolated; cast playlist URLs retain authorization', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(playlist(1))).status, 200);
    const cast = await f.request(playlist(2, 30, '&cast_token=fixture-token'));
    assert.equal(cast.status, 200);
    assert.match(cast.body, /init\.mp4\?cast_token=fixture-token/);
    assert.match(cast.body, /seg_00000\.m4s\?cast_token=fixture-token/);
    await f.request(`/api/hls/${id(1)}/stop`, 'a', 'POST');
    assert.equal((await f.request(`/api/hls/${id(2)}/alive`)).status, 200);
  } finally { await f.close(); }
});


test('playback can start with one complete segment while the EVENT playlist is still growing', async () => {
  const f = await fixture({ segmentCount: 1 });
  try {
    const response = await f.request(playlist(1, 1049));
    assert.equal(response.status, 200);
    assert.equal((response.body.match(/#EXTINF:/g) || []).length, 1);
    assert.ok(!response.body.includes('#EXT-X-ENDLIST'));
    assert.equal((await f.request(`/hls/film/${id(1)}/init.mp4`)).status, 200);
    const segment = await f.request(`/hls/film/${id(1)}/seg_00000.m4s`);
    assert.equal(segment.status, 200);
    assert.equal(segment.body, '1049');
  } finally { await f.close(); }
});
