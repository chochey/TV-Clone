const { test } = require('node:test');
const assert = require('node:assert/strict');
const createProbe = require('./probe');
const make = runner => createProbe({ DATA_DIR: '/synthetic-nonexistent-probe', loadJSON: (_file, fallback) => structuredClone(fallback), saveJSON: () => {}, runner });

test('duration probes share one in-flight job and failed attempts remain retryable', async () => {
  let reject, calls = 0;
  const runner = { run: () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); } };
  const probe = make(runner);
  const first = probe.probeDurationWithReason('/sample.mkv'), second = probe.probeDurationWithReason('/sample.mkv');
  assert.equal(first, second); assert.equal(calls, 1);
  reject(Object.assign(new Error('Media tool timed out'), { code: 'MEDIA_TIMEOUT' }));
  assert.equal((await first).duration, 0); assert.equal(probe.durationCache['/sample.mkv'], undefined);
  runner.run = async () => ({ stdout: '{"format":{"duration":"42"}}', stderr: '' });
  assert.equal(await probe.probeDurationAsync('/sample.mkv'), 42);
});

test('codec and subtitle probe failures do not permanently poison their caches', async () => {
  const runner = { run: async () => { throw new Error('Media tool timed out'); } }, probe = make(runner);
  assert.equal(await probe.probeFileAsync('/sample.mkv'), 'unknown');
  assert.deepEqual(await probe.probeSubtitlesAsync('/sample.mkv'), []);
  assert.equal(probe.probeCache['/sample.mkv'], undefined); assert.equal(probe.subProbeCache['/sample.mkv'], undefined);
  runner.run = async (_command, args) => ({ stdout: args.includes('-select_streams')
    ? '{"streams":[{"index":2,"codec_name":"subrip","disposition":{"forced":1}}]}'
    : '{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","height":720,"level":40}]}', stderr: '' });
  assert.equal(await probe.probeFileAsync('/sample.mkv'), 'h264');
  assert.equal((await probe.probeSubtitlesAsync('/sample.mkv'))[0].forced, true);
  assert.equal(probe.heightCache['/sample.mkv'], 720);
});

test('multiaudio MP4 always uses mapped HLS and fresh probes preserve selection metadata', async () => {
  let args;
  const streams = [
    { index: 0, codec_type: 'video', codec_name: 'h264', height: 1080, pix_fmt: 'yuv420p' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'rus' }, disposition: { default: 1 } },
    { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2,
      tags: { language: 'eng', handler_name: 'Commentary' }, disposition: { comment: 1 } },
    { index: 3, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'en-GB' } },
  ];
  const probe = make({ run: async (_command, requestArgs) => { args = requestArgs; return { stdout: JSON.stringify({ streams }) }; } });
  await probe.probeFileAsync('/sample.mp4');
  assert.match(args[args.indexOf('-show_entries') + 1], /stream_disposition=.*default/);
  assert.equal(probe.audioTracksCache['/sample.mp4'][1].commentary, true);
  assert.equal(probe.audioTracksCache['/sample.mp4'][1].title, 'Commentary');
  assert.equal(probe.getStreamMode('/sample.mp4'), 'remux');
  probe.audioTracksCache['/sample.mp4'] = [probe.audioTracksCache['/sample.mp4'][2]];
  assert.equal(probe.getStreamMode('/sample.mp4'), 'direct', 'single stereo track remains direct');
});

test('routing uses the selected track codec and channels instead of stale first-track audio', () => {
  const probe = make({ run: async () => { throw Error('not needed'); } });
  probe.probeCache['/sample.mp4'] = 'h264';
  probe.audioProbeCache['/sample.mp4'] = 'aac';
  probe.audioTracksCache['/sample.mp4'] = [{ index: 3, lang: 'eng', codec: 'eac3', channels: 2 }];
  assert.equal(probe.getStreamMode('/sample.mp4'), 'remux');
  probe.audioTracksCache['/sample.mp4'][0].codec = 'aac';
  probe.audioTracksCache['/sample.mp4'][0].channels = 6;
  assert.equal(probe.getStreamMode('/sample.mp4'), 'remux');
});
