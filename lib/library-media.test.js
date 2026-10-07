const test = require('node:test');
const assert = require('node:assert/strict');
const { AUDIO_EXTENSIONS, extensionsForFolder, classifyMediaKind, normalizeFolderMediaKind } = require('./library-media');

test('legacy video folders and arbitrary custom types retain their classification', () => {
  assert.equal(normalizeFolderMediaKind({ type: 'movie' }), 'movie');
  assert.equal(normalizeFolderMediaKind({ type: 'show' }), 'show');
  assert.equal(normalizeFolderMediaKind({ type: 'anime' }), 'mixed');
  assert.equal(classifyMediaKind('Anime.S01E02.mkv', { type: 'anime' }), 'show');
  assert.equal(classifyMediaKind('Anime Movie.mp4', { type: 'anime' }), 'movie');
  assert.equal(classifyMediaKind('Lecture.mp4', { type: 'custom-lectures', mediaKind: 'show' }), 'show');
  assert.equal(classifyMediaKind('Movie.S01E02.mp4', { mediaKind: 'movie' }), 'movie');
});

test('audio is classified before episode filename guessing and stays out of video-only folders', () => {
  for (const extension of AUDIO_EXTENSIONS) {
    assert.equal(classifyMediaKind('Podcast.S01E02' + extension.toUpperCase(), { type: 'custom-podcasts', mediaKind: 'mixed' }), 'audio');
    assert.ok(extensionsForFolder({ mediaKind: 'mixed' }).includes(extension));
    assert.ok(extensionsForFolder({ mediaKind: 'audio' }).includes(extension));
    assert.ok(!extensionsForFolder({ type: 'movie' }).includes(extension));
  }
  assert.ok(!extensionsForFolder({ mediaKind: 'audio' }).includes('.mkv'));
});
