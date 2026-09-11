const test = require('node:test');
const assert = require('node:assert');
const {
  isVideoSearchHit,
  torrentHasVideoFile,
  filterSearchResults,
} = require('./video-torrent');

test('search hits whose title is an .exe are hidden (the Silo CAKES fake)', () => {
  assert.strictEqual(
    isVideoSearchHit({ fileName: 'Silo S03E10 1080p WEB H264-CAKES.exe' }),
    false,
  );
});

test('search hits with other non-video payloads are hidden', () => {
  for (const fileName of [
    'Windows.11.ISO',
    'Some.Release.1080p.zip',
    'payload.rar',
    'Setup.msi',
    'Movie.scr',
    'App.apk',
    'Disc.iso',
    'archive.7z',
  ]) {
    assert.strictEqual(isVideoSearchHit({ fileName }), false, fileName);
  }
});

test('normal video listings stay visible, even without a file extension', () => {
  for (const fileName of [
    'Silo S03E10 Troy 1080p HEVC x265-MeGusta (TV)',
    'Silo.S03E10.Troy.1080p.ATVP.WEB-DL.DDP5.1.ENG.ITA.Atmos.H265-TBK',
    'Show.S01E01.mkv',
    'Film (2024).mp4',
    'Something.avi',
  ]) {
    assert.strictEqual(isVideoSearchHit({ fileName }), true, fileName);
  }
});

test('filterSearchResults drops junk and preserves qBittorrent payload shape', () => {
  const filtered = filterSearchResults({
    status: 'Running',
    total: 3,
    results: [
      { fileName: 'Silo S03E10 Troy 1080p HEVC x265-MeGusta (TV)', fileSize: 7e8 },
      { fileName: 'Silo S03E10 1080p WEB H264-CAKES.exe', fileSize: 1e9 },
      { fileName: 'Silo.S03E10.1080p.x265-ELITE', fileSize: 6e8 },
    ],
  });
  assert.strictEqual(filtered.status, 'Running');
  assert.strictEqual(filtered.results.length, 2);
  assert.deepStrictEqual(
    filtered.results.map((r) => r.fileName),
    [
      'Silo S03E10 Troy 1080p HEVC x265-MeGusta (TV)',
      'Silo.S03E10.1080p.x265-ELITE',
    ],
  );
});

test('a torrent whose only file is an .exe is not video content', () => {
  assert.strictEqual(
    torrentHasVideoFile([{ name: 'Silo S03E10 1080p WEB H264-CAKES.exe', size: 1074581504 }]),
    false,
  );
});

test('a season pack with mkv files is video content even if junk extras exist', () => {
  assert.strictEqual(
    torrentHasVideoFile([
      { name: 'Show.S02E01.mkv' },
      { name: 'Show.S02E02.mkv' },
      { name: 'RARBG.txt' },
    ]),
    true,
  );
});

test('empty or missing file lists are unknown, not a drop', () => {
  assert.strictEqual(torrentHasVideoFile([]), null);
  assert.strictEqual(torrentHasVideoFile(null), null);
  assert.strictEqual(torrentHasVideoFile(undefined), null);
});
