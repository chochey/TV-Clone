const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  migrateProfileIds, retainedPathFor, newPathFor, tempPathFor, buildRemuxArgs,
} = require('./conversion-worker');

const OLD = 'aaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbb';

// Mirrors lib/profile-data.js's DEFAULTS exactly, plus real-shaped entries —
// the Cape Fear history rows here are the actual shape found in
// data/profile_default.json ({id, timestamp, title}).
function freshProfile(over = {}) {
  return {
    progress: {}, history: [], queue: [], watchlist: [], watched: {},
    dismissed: { continueWatching: {}, recentlyAdded: {} },
    quality: 'auto', subtitleOffsets: {},
    ...over,
  };
}

test('a profile with no reference to the old id is returned untouched', () => {
  const data = freshProfile({ progress: { other: { currentTime: 10 } } });
  const { data: out, touched } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(touched, false);
  assert.deepStrictEqual(out, data);
});

test('progress migrates and the old key is gone', () => {
  const data = freshProfile({ progress: { [OLD]: { currentTime: 1200, duration: 5400 } } });
  const { data: out, touched } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(touched, true);
  assert.deepStrictEqual(out.progress[NEW], { currentTime: 1200, duration: 5400 });
  assert.strictEqual(Object.hasOwn(out.progress, OLD), false);
});

test('watched flag migrates', () => {
  const data = freshProfile({ watched: { [OLD]: true } });
  const { data: out } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(out.watched[NEW], true);
  assert.strictEqual(Object.hasOwn(out.watched, OLD), false);
});

test('history entries update id in place, preserving order and other fields', () => {
  const data = freshProfile({
    history: [
      { id: OLD, timestamp: 111, title: 'X' },
      { id: 'unrelated', timestamp: 222, title: 'Y' },
    ],
  });
  const { data: out, touched } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(touched, true);
  assert.deepStrictEqual(out.history, [
    { id: NEW, timestamp: 111, title: 'X' },
    { id: 'unrelated', timestamp: 222, title: 'Y' },
  ]);
});

test('queue and watchlist are id-string arrays, not objects — confirmed against server.js call sites', () => {
  const data = freshProfile({ queue: [OLD, 'other'], watchlist: ['other', OLD] });
  const { data: out } = migrateProfileIds(data, OLD, NEW);
  assert.deepStrictEqual(out.queue, [NEW, 'other']);
  assert.deepStrictEqual(out.watchlist, ['other', NEW]);
});

test('dismissed.continueWatching and recentlyAdded both migrate independently', () => {
  const data = freshProfile({
    dismissed: { continueWatching: { [OLD]: 1700000000000 }, recentlyAdded: { [OLD]: 1700000001000 } },
  });
  const { data: out, touched } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(touched, true);
  assert.strictEqual(out.dismissed.continueWatching[NEW], 1700000000000);
  assert.strictEqual(out.dismissed.recentlyAdded[NEW], 1700000001000);
  assert.strictEqual(Object.hasOwn(out.dismissed.continueWatching, OLD), false);
  assert.strictEqual(Object.hasOwn(out.dismissed.recentlyAdded, OLD), false);
});

test('only one side of dismissed migrating still reports touched and preserves the other side', () => {
  const data = freshProfile({ dismissed: { continueWatching: { [OLD]: 1 }, recentlyAdded: { other: 2 } } });
  const { data: out, touched } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(touched, true);
  assert.strictEqual(out.dismissed.continueWatching[NEW], 1);
  assert.deepStrictEqual(out.dismissed.recentlyAdded, { other: 2 });
});

test('subtitleOffsets migrates', () => {
  const data = freshProfile({ subtitleOffsets: { [OLD]: -0.5 } });
  const { data: out } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(out.subtitleOffsets[NEW], -0.5);
});

test('everything migrates together in one pass on a fully-populated profile', () => {
  const data = freshProfile({
    progress: { [OLD]: { currentTime: 5 } },
    watched: { [OLD]: true },
    history: [{ id: OLD, timestamp: 1, title: 'X' }],
    queue: [OLD],
    watchlist: [OLD],
    dismissed: { continueWatching: { [OLD]: 1 }, recentlyAdded: { [OLD]: 2 } },
    subtitleOffsets: { [OLD]: 0.2 },
  });
  const { data: out, touched } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(touched, true);
  assert.ok(Object.hasOwn(out.progress, NEW));
  assert.ok(Object.hasOwn(out.watched, NEW));
  assert.strictEqual(out.history[0].id, NEW);
  assert.deepStrictEqual(out.queue, [NEW]);
  assert.deepStrictEqual(out.watchlist, [NEW]);
  assert.ok(Object.hasOwn(out.dismissed.continueWatching, NEW));
  assert.ok(Object.hasOwn(out.dismissed.recentlyAdded, NEW));
  assert.ok(Object.hasOwn(out.subtitleOffsets, NEW));
  // Nothing keyed by the old id survives anywhere.
  const json = JSON.stringify(out);
  assert.ok(!json.includes(OLD), 'old id must not appear anywhere in the migrated profile');
});

test('the input object is never mutated — same reference in, unequal reference out', () => {
  const data = freshProfile({ progress: { [OLD]: { currentTime: 5 } } });
  const snapshot = JSON.parse(JSON.stringify(data));
  const { data: out } = migrateProfileIds(data, OLD, NEW);
  assert.deepStrictEqual(data, snapshot, 'the original object must be untouched');
  assert.notStrictEqual(out, data);
});

test('oldId === newId is a no-op, not an error', () => {
  const data = freshProfile({ progress: { [OLD]: { currentTime: 5 } } });
  const { data: out, touched } = migrateProfileIds(data, OLD, OLD);
  assert.strictEqual(touched, false);
  assert.strictEqual(out, data);
});

test('a null/undefined profile does not throw', () => {
  assert.deepStrictEqual(migrateProfileIds(null, OLD, NEW), { data: null, touched: false });
  assert.deepStrictEqual(migrateProfileIds(undefined, OLD, NEW), { data: undefined, touched: false });
});

test('a real Cape Fear-shaped history entry migrates correctly (ground-truthed against live data)', () => {
  // Actual shape pulled from data/profile_default.json during this session.
  const data = freshProfile({
    history: [
      { id: OLD, timestamp: 1786234758785, title: 'Cape Fear - S01E02 - Why Would I Want to Hurt You' },
      { id: '4125a313ae525d53', timestamp: 1786230768675, title: 'Cape Fear - S01E01 - Fingers and Toes' },
    ],
  });
  const { data: out } = migrateProfileIds(data, OLD, NEW);
  assert.strictEqual(out.history[0].id, NEW);
  assert.strictEqual(out.history[0].title, 'Cape Fear - S01E02 - Why Would I Want to Hurt You');
  assert.strictEqual(out.history[1].id, '4125a313ae525d53', 'an unrelated entry must not change');
});

// ── path helpers ───────────────────────────────────────────────────────

test('retainedPathFor nests under a dotdir sibling the scanner already skips', () => {
  const p = retainedPathFor('/mnt/media/Movies/X (2011)/X (2011).mkv');
  assert.strictEqual(p, '/mnt/media/Movies/X (2011)/.converted-originals/X (2011).mkv');
});

test('newPathFor keeps the filename stem so sidecar subtitle discovery still matches', () => {
  // fs-helpers.findSubtitles matches on path.parse(video).name, which is
  // unaffected by the container extension changing.
  assert.strictEqual(
    newPathFor('/mnt/media/Movies/X (2011)/X (2011).mkv'),
    '/mnt/media/Movies/X (2011)/X (2011).mp4',
  );
});

test('tempPathFor is a dotfile carrying the pid, distinguishable from a real file', () => {
  const p = tempPathFor('/mnt/media/Movies/X (2011)/X (2011).mkv');
  assert.ok(path.basename(p).startsWith('.'));
  assert.ok(p.includes(String(process.pid)));
  assert.ok(p.endsWith('.mp4'));
});

test('restore is the exact inverse of the conversion migration', () => {
  // Convert moves oldId -> newId; restore must move newId -> oldId and leave
  // the profile byte-identical to where it started, or "undo" is a lie.
  const before = freshProfile({
    progress: { [OLD]: { currentTime: 99, duration: 600 } },
    watched: { [OLD]: true },
    history: [{ id: OLD, timestamp: 1, title: 'X' }],
    queue: [OLD], watchlist: [OLD],
    dismissed: { continueWatching: { [OLD]: 1 }, recentlyAdded: {} },
    subtitleOffsets: { [OLD]: 0.5 },
  });
  const snapshot = JSON.parse(JSON.stringify(before));
  const converted = migrateProfileIds(before, OLD, NEW).data;
  const restored = migrateProfileIds(converted, NEW, OLD).data;
  assert.deepStrictEqual(restored, snapshot,
    'a convert followed by a restore must round-trip the profile exactly');
});

// ── duration comparison ──────────────────────────────────────────────────
const { mediaDurationOf } = require('./conversion-worker');

test('a subtitle track outlasting the picture does not inflate the duration', () => {
  // The real false positive this fixes: Mr Inbetween S02E02 had video 1558.954,
  // audio 1558.997 and a subtitle track running to 1611.152, so the CONTAINER
  // claimed 1611s. The remux drops subtitles by design, making its 1559s output
  // correct — but a container-to-container check called that 52s of lost data
  // and refused to convert a perfectly good file.
  const mkv = {
    streams: [
      { codec_type: 'video', tags: { DURATION: '00:25:58.954000000' } },
      { codec_type: 'audio', tags: { DURATION: '00:25:58.997000000' } },
      { codec_type: 'subtitle', tags: { DURATION: '00:26:51.152000000' } },
    ],
    format: { duration: '1611.152000' },
  };
  assert.ok(Math.abs(mediaDurationOf(mkv) - 1558.997) < 0.01,
    'must report the video/audio length, not the subtitle-inflated container');
});

test('MKV DURATION tags and numeric stream durations are both understood', () => {
  assert.ok(Math.abs(mediaDurationOf({
    streams: [{ codec_type: 'video', tags: { DURATION: '01:02:03.500000000' } }],
  }) - 3723.5) < 0.01, 'HH:MM:SS.nnn tag');
  assert.ok(Math.abs(mediaDurationOf({
    streams: [{ codec_type: 'video', duration: '1558.996833' }],
  }) - 1558.996833) < 0.01, 'numeric field');
});

test('a genuinely truncated file is still caught', () => {
  // King of Queens S06E04: container says 1332s, real data ends at 331.8s.
  // The remux output must still read as far shorter than the source, or the
  // fix above would have traded a false positive for a false negative.
  const src = { streams: [{ codec_type: 'video', tags: { DURATION: '00:22:12.010000000' } }], format: { duration: '1332.010000' } };
  const out = { streams: [{ codec_type: 'video', duration: '331.789000' }], format: { duration: '331.810000' } };
  assert.ok(Math.abs(mediaDurationOf(src) - mediaDurationOf(out)) > 1,
    'real truncation must still exceed the 1s tolerance');
});

test('duration falls back to the container when no stream reports one', () => {
  assert.strictEqual(mediaDurationOf({ streams: [{ codec_type: 'video' }], format: { duration: '42.5' } }), 42.5);
  assert.strictEqual(mediaDurationOf({ streams: [], format: {} }), 0);
  assert.strictEqual(mediaDurationOf(null), 0);
});

test('subtitle and data streams never contribute to the duration', () => {
  const probe = {
    streams: [
      { codec_type: 'video', duration: '100' },
      { codec_type: 'subtitle', duration: '9999' },
      { codec_type: 'data', duration: '8888' },
    ],
  };
  assert.strictEqual(mediaDurationOf(probe), 100);
});

// ── resource limits ──────────────────────────────────────────────────────
const { withResourceLimits } = require('./conversion-worker');

test('with no niceness the command runs ffmpeg directly', () => {
  const [cmd, args] = withResourceLimits(['-v', 'error', '-i', 'x.mkv'], { niceness: 0 });
  assert.strictEqual(cmd, 'ffmpeg');
  assert.deepStrictEqual(args, ['-v', 'error', '-i', 'x.mkv']);
});

test('niceness wraps the call in nice AND ionice, not just nice', () => {
  // ionice matters more than nice for this workload: these jobs are almost
  // pure IO, so CPU priority alone would not stop a batch starving a stream.
  const [cmd, args] = withResourceLimits(['-v', 'error', '-i', 'x.mkv'], { niceness: 19 });
  assert.strictEqual(cmd, 'nice');
  assert.deepStrictEqual(args.slice(0, 6), ['-n', '19', 'ionice', '-c', '3', 'ffmpeg']);
  assert.deepStrictEqual(args.slice(6), ['-v', 'error', '-i', 'x.mkv']);
});

test('ffmpegThreads is inserted as a global option, before the input', () => {
  const [, args] = withResourceLimits(['-v', 'error', '-i', 'x.mkv'], { niceness: 0, ffmpegThreads: 2 });
  assert.deepStrictEqual(args, ['-v', 'error', '-threads', '2', '-i', 'x.mkv']);
  assert.ok(args.indexOf('-threads') < args.indexOf('-i'), '-threads must precede -i to be global');
});

test('threads and niceness compose without corrupting the arg order', () => {
  const [cmd, args] = withResourceLimits(['-v', 'error', '-i', 'x.mkv'], { niceness: 10, ffmpegThreads: 3 });
  assert.strictEqual(cmd, 'nice');
  const ff = args.indexOf('ffmpeg');
  assert.deepStrictEqual(args.slice(ff + 1), ['-v', 'error', '-threads', '3', '-i', 'x.mkv']);
});

test('the original arg array is never mutated', () => {
  const original = ['-v', 'error', '-i', 'x.mkv'];
  withResourceLimits(original, { niceness: 19, ffmpegThreads: 4 });
  assert.deepStrictEqual(original, ['-v', 'error', '-i', 'x.mkv']);
});

// ── -map_chapters -1 regression ──────────────────────────────────────────
// Found on a real pilot run: without this flag, ffmpeg carries MKV chapter
// markers into the MP4 as an orphaned "bin_data"/text stream tagged
// SubtitleHandler (confirmed on Rick and Morty S06E03, 5 chapters — dropped
// after adding the flag, reproduced 100% before it). This app has no
// chapter-navigation UI, so nothing of value is lost by dropping them.
// A live-ffmpeg fixture proved the fix works (see session notes); this test
// guards against someone removing the flag later without re-discovering why
// it's there, without needing ffmpeg present just to run the unit suite.
test('the remux always drops chapters, so MKV chapter markers cannot leak through as a stray stream', () => {
  const args = buildRemuxArgs('/mnt/media/TV/X/X.mkv', '/mnt/media/TV/X/.X.converting.1.mp4');
  const i = args.indexOf('-map_chapters');
  assert.notStrictEqual(i, -1, '-map_chapters must be present');
  assert.strictEqual(args[i + 1], '-1', '-map_chapters must be set to -1 (drop all)');
});

test('the remux still maps exactly one video and the audio streams, nothing else', () => {
  const args = buildRemuxArgs('/mnt/media/TV/X/X.mkv', '/mnt/media/TV/X/.X.converting.1.mp4');
  const mapIndices = args.reduce((acc, a, i) => (a === '-map' ? [...acc, args[i + 1]] : acc), []);
  assert.deepStrictEqual(mapIndices, ['0:v', '0:a']);
  assert.ok(args.includes('-sn'), 'subtitles must never be muxed in — they are extracted to sidecars separately');
  assert.strictEqual(args[args.indexOf('-c') + 1], 'copy', 'must never re-encode — this tier is a container fix, not a transcode');
});
