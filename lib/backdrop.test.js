const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickTimestamp, buildVf, ffmpegArgs, HDR_TRANSFERS, BACKDROP_WIDTH } = require('./backdrop');

test('pickTimestamp: 25% into a normal feature', () => {
  assert.equal(pickTimestamp(6000), 1500); // 100 min film -> 25 min in
});

test('pickTimestamp: never inside the first minute', () => {
  assert.equal(pickTimestamp(200), 60); // 25% would be 50s -> clamped to 60
});

test('pickTimestamp: never inside the last two minutes', () => {
  // 25% of 130s = 32.5s; latest allowed is 130-120=10s -> clamps to 10
  assert.equal(pickTimestamp(130), 10);
});

test('pickTimestamp: unknown duration falls back to 5 minutes', () => {
  assert.equal(pickTimestamp(0), 300);
  assert.equal(pickTimestamp(undefined), 300);
  assert.equal(pickTimestamp(-3), 300);
});

test('buildVf: SDR sources just scale', () => {
  assert.equal(buildVf(false), `scale=${BACKDROP_WIDTH}:-2`);
});

test('buildVf: HDR sources scale first, then tonemap to BT.709', () => {
  const vf = buildVf(true);
  assert.ok(vf.startsWith(`scale=${BACKDROP_WIDTH}:-2,`));
  assert.match(vf, /tonemap=tonemap=hable/);
  assert.match(vf, /zscale=t=bt709:m=bt709:r=tv/);
  assert.ok(vf.endsWith('format=yuv420p'));
});

test('HDR_TRANSFERS covers PQ and HLG only', () => {
  assert.ok(HDR_TRANSFERS.has('smpte2084'));
  assert.ok(HDR_TRANSFERS.has('arib-std-b67'));
  assert.ok(!HDR_TRANSFERS.has('bt709'));
  assert.ok(!HDR_TRANSFERS.has(''));
});

test('ffmpegArgs: fast-seeks before input and grabs exactly one frame', () => {
  const args = ffmpegArgs('/mnt/media/Movies/x.mkv', 1500, 'scale=1280:-2', '/data/backdrops/abc.jpg');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'seek must precede input for fast seek');
  assert.equal(args[args.indexOf('-ss') + 1], '1500');
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.equal(args[args.indexOf('-vf') + 1], 'scale=1280:-2');
  assert.equal(args[args.length - 1], '/data/backdrops/abc.jpg');
});
