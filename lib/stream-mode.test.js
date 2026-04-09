// Run with: node lib/stream-mode.test.js
const assert = require('assert');
const { computeStreamMode } = require('./stream-mode');

const cases = [
  // direct
  [{ ext: '.mp4', codec: 'h264', audioCodec: 'aac' }, 'direct'],
  [{ ext: '.mp4', codec: 'h264', audioCodec: 'mp3' }, 'direct'],
  [{ ext: '.mp4', codec: 'h264', audioCodec: 'opus' }, 'direct'],
  [{ ext: '.MP4', codec: 'h264', audioCodec: 'aac' }, 'direct'], // case-insensitive ext
  [{ ext: '.mp4', codec: 'h264', audioCodec: null }, 'direct'],
  [{ ext: '.mp4', codec: 'h264', audioCodec: undefined }, 'direct'],
  // remux (h264 in non-mp4, or h264 with non-browser audio)
  [{ ext: '.mkv', codec: 'h264', audioCodec: 'aac' }, 'remux'],
  [{ ext: '.mp4', codec: 'h264', audioCodec: 'ac3' }, 'remux'],
  [{ ext: '.mp4', codec: 'h264', audioCodec: 'dts' }, 'remux'],
  [{ ext: '.avi', codec: 'h264', audioCodec: 'mp3' }, 'remux'],
  // transcode (anything non-h264)
  [{ ext: '.mkv', codec: 'hevc', audioCodec: 'aac' }, 'transcode'],
  [{ ext: '.mp4', codec: 'hevc', audioCodec: 'aac' }, 'transcode'],
  [{ ext: '.mkv', codec: 'mpeg4', audioCodec: 'mp3' }, 'transcode'],
  [{ ext: '.webm', codec: 'vp9', audioCodec: 'opus' }, 'transcode'],
  [{ ext: '.mkv', codec: 'av1', audioCodec: 'opus' }, 'transcode'],
  // unknown
  [{ ext: '.mp4', codec: null, audioCodec: 'aac' }, 'unknown'],
  [{ ext: '.mp4', codec: undefined, audioCodec: 'aac' }, 'unknown'],
  [{ ext: '.mp4', codec: '', audioCodec: 'aac' }, 'unknown'],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const actual = computeStreamMode(input);
  try {
    assert.strictEqual(actual, expected);
    pass++;
  } catch {
    fail++;
    console.error(`FAIL ${JSON.stringify(input)} -> expected ${expected}, got ${actual}`);
  }
}

console.log(`stream-mode: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
