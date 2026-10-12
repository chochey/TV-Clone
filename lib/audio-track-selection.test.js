const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAudioLanguage, selectAudioTrack, selectAudioTrackIndex, audioTrackFromStream,
  hasAudioTrackMetadata, formatAudioTracks, audioTrackTitle } = require('./audio-track-selection');

test('English aliases and locales select the English track despite a foreign default', () => {
  for (const language of ['en', 'eng', 'English', 'EN-us', 'en_GB', 'eng-US', 'English (US)']) {
    assert.equal(normalizeAudioLanguage(language), 'eng');
    const tracks = [{ index: 1, lang: 'rus', default: true }, { index: 2, lang: 'spa' }, { index: 3, lang: language }];
    assert.equal(selectAudioTrackIndex(tracks), 3, language);
    assert.equal(selectAudioTrack(tracks), tracks[2]);
  }
});

test('main English takes precedence over default English commentary or descriptive audio', () => {
  for (const auxiliary of [{ title: 'English commentary' }, { title: 'Audio Description' },
    { commentary: true }, { descriptive: true }, { disposition: { comment: 1 } },
    { disposition: { visual_impaired: 1 } }, { disposition: { descriptions: 1 } }]) {
    assert.equal(selectAudioTrackIndex([
      { index: 1, lang: 'eng', default: true, ...auxiliary },
      { index: 2, lang: 'rus' }, { index: 3, lang: 'eng', title: 'Surround' },
    ]), 3);
  }
  assert.equal(selectAudioTrackIndex([{ index: 1, lang: 'rus' },
    { index: 3, lang: 'eng', title: 'English commentary' }]), 3, 'available English still wins');
});

test('explicit selections including zero are honored and invalid indexes are not substituted', () => {
  const tracks = [{ index: 0, lang: 'rus' }, { index: 3, lang: 'eng' }];
  assert.equal(selectAudioTrackIndex(tracks), 3);
  assert.equal(selectAudioTrackIndex(tracks, 0), 0);
  assert.equal(selectAudioTrackIndex(tracks, 3), 3);
  assert.equal(selectAudioTrackIndex(tracks, 2), null);
  assert.equal(selectAudioTrackIndex([]), null);
});

test('missing English metadata retains default or first without assuming unknown is English', () => {
  const tracks = [{ index: 1, lang: 'und' }, { index: 2, lang: 'spa', default: true }];
  assert.equal(selectAudioTrackIndex(tracks), 2);
  assert.equal(selectAudioTrackIndex(tracks.map(({ default: ignored, ...track }) => track)), 1);
  assert.equal(selectAudioTrackIndex([{ index: 1, lang: 'rus', default: true },
    { index: 2, lang: 'und', title: 'English Stereo' }]), 2);
});

test('ffprobe dispositions and MP4 handler names survive cache normalization and labels', () => {
  const streams = [
    { index: 1, codec_name: 'aac', channels: 2, tags: { language: 'rus' }, disposition: { default: 1 } },
    { index: 2, codec_name: 'aac', channels: 2, tags: { language: 'eng', handler_name: 'English Commentary' }, disposition: { comment: 1 } },
    { index: 3, codec_name: 'eac3', channels: 6, channel_layout: '5.1', tags: { language: 'en-US', title: 'English Main' } },
  ];
  assert.equal(selectAudioTrackIndex(streams), 3);
  const cached = streams.map(audioTrackFromStream);
  assert.equal(selectAudioTrackIndex(cached), 3);
  assert.equal(cached[1].title, 'English Commentary');
  assert.equal(cached[1].commentary, true);
  assert.equal(hasAudioTrackMetadata(cached), true);
  assert.equal(hasAudioTrackMetadata([{ index: 1, lang: 'eng' }]), false);
  assert.equal(hasAudioTrackMetadata(undefined), false);
  const tracks = formatAudioTracks(cached);
  assert.deepEqual(tracks.map(track => track.isDefault), [false, false, true]);
  assert.equal(tracks[2].label, 'English Main · 5.1 · EAC3');
});

test('generic MP4 handler names never hide the language and named dubs keep both labels', () => {
  for (const title of ['SoundHandler', 'AudioHandler', 'sound handler', 'Handler']) {
    const raw = { index: 1, tags: { language: 'eng', handler_name: title }, codec_name: 'aac', channels: 2 };
    assert.equal(audioTrackTitle(raw), '');
    assert.equal(formatAudioTracks([audioTrackFromStream(raw)])[0].label, 'English · Stereo · AAC');
    assert.equal(formatAudioTracks([{ index: 1, lang: 'eng', title }])[0].label, 'English', 'legacy generic titles also fall back');
  }
  assert.equal(formatAudioTracks([{ index: 2, lang: 'rus', title: 'Studio Dub' }], { rus: 'Russian' })[0].label, 'Russian · Studio Dub');
  assert.equal(formatAudioTracks([{ index: 3, lang: 'eng', title: 'English Dub' }])[0].label, 'English Dub');
});
