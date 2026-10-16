const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createOrganizerWatch = require('./organizer-watch');

function tmpLog() {
  const p = path.join(os.tmpdir(), `orgwatch-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  fs.writeFileSync(p, '[2026-06-23 05:00:00] Watching /mnt/media/Share (polling every 30s)\n');
  return p;
}

// fs.watch latency varies; poll for a condition instead of a fixed sleep.
async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

test('fires once (debounced) on a Moved -> line', async () => {
  const logPath = tmpLog();
  let calls = 0;
  const w = createOrganizerWatch({ logPath, debounceMs: 60, onMove: () => { calls++; } });
  w.setup();
  // A burst of episode moves should coalesce into one rescan.
  for (let i = 1; i <= 5; i++) {
    fs.appendFileSync(logPath, `[2026-06-23 05:47:1${i}] Moved -> /mnt/media/TV/Show/Season 01/Show - S01E0${i}.mkv\n`);
  }
  const fired = await waitFor(() => calls >= 1);
  assert.equal(fired, true, 'onMove should fire after a move line');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(calls, 1, 'burst should coalesce into a single rescan');
  w.close();
  fs.rmSync(logPath, { force: true });
});

test('does NOT fire on heartbeat-only appends', async () => {
  const logPath = tmpLog();
  let calls = 0;
  const w = createOrganizerWatch({ logPath, debounceMs: 60, onMove: () => { calls++; } });
  w.setup();
  fs.appendFileSync(logPath, '[2026-06-23 05:05:00] Still watching...\n');
  fs.appendFileSync(logPath, '[2026-06-23 05:05:30] SKIP: No OMDb match for series: Whatever\n');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(calls, 0, 'heartbeat / SKIP lines must not trigger a rescan');
  w.close();
  fs.rmSync(logPath, { force: true });
});

test('fires on Deleted source folder', async () => {
  const logPath = tmpLog();
  let calls = 0;
  const w = createOrganizerWatch({ logPath, debounceMs: 60, onMove: () => { calls++; } });
  w.setup();
  fs.appendFileSync(logPath, '[2026-06-23 05:48:00] Deleted source folder: Some.Release.1080p\n');
  assert.equal(await waitFor(() => calls >= 1), true);
  w.close();
  fs.rmSync(logPath, { force: true });
});

test('handles truncation/rotation (size shrinks, later move still fires)', async () => {
  const logPath = tmpLog();
  fs.appendFileSync(logPath, '[2026-06-23 05:47:01] Moved -> /mnt/media/Movies/A/A.mkv\n');
  let calls = 0;
  const w = createOrganizerWatch({ logPath, debounceMs: 60, onMove: () => { calls++; } });
  w.setup();
  // wait for initial offset to settle past existing content
  await new Promise(r => setTimeout(r, 100));
  // rotate: truncate to empty
  fs.writeFileSync(logPath, '');
  await new Promise(r => setTimeout(r, 100));
  fs.appendFileSync(logPath, '[2026-06-23 06:00:00] Moved -> /mnt/media/Movies/B/B.mkv\n');
  assert.equal(await waitFor(() => calls >= 1), true, 'move after rotation should still fire');
  w.close();
  fs.rmSync(logPath, { force: true });
});

test('missing file at setup does not throw; watches once it appears', async () => {
  const logPath = path.join(os.tmpdir(), `orgwatch-missing-${Date.now()}.log`);
  let calls = 0;
  const w = createOrganizerWatch({ logPath, debounceMs: 60, retryMs: 80, onMove: () => { calls++; } });
  assert.doesNotThrow(() => w.setup());
  fs.writeFileSync(logPath, '[2026-06-23 06:00:00] Watching /mnt/media/Share\n');
  await new Promise(r => setTimeout(r, 200)); // let retry pick it up
  fs.appendFileSync(logPath, '[2026-06-23 06:01:00] Moved -> /mnt/media/Movies/C/C.mkv\n');
  assert.equal(await waitFor(() => calls >= 1, 2000), true);
  w.close();
  fs.rmSync(logPath, { force: true });
});

// ── Needs-attention notifications ────────────────────────────────────────────
// This path had no tests, and drifted: the organizer's structured "REVIEW: {json}"
// events (duplicates, name conflicts, ambiguous episodes, an unverifiable library)
// matched none of the three legacy phrases, so 58 real review events over 11
// releases produced zero notifications.
const review = (over = {}) => `[2026-10-08 20:42:21] REVIEW: ${JSON.stringify({
  type: 'movie', title: 'Insidious: Out of the Further', source: 'Insidious Out Of The Further (2026) [1080p]',
  reason: 'Destination conflict: a.mkv -> /mnt/media/Movies/Insidious (2026)/Insidious (2026).mkv; source retained', ...over })}\n`;

test('a REVIEW event notifies, naming the release and the reason', async () => {
  const logPath = tmpLog();
  const batches = [];
  const w = createOrganizerWatch({ logPath, debounceMs: 60, onMove() {}, onAttention: batch => batches.push(batch) });
  w.setup();
  fs.appendFileSync(logPath, review());
  assert.equal(await waitFor(() => batches.length >= 1), true, 'a REVIEW line must raise attention');
  assert.equal(batches[0].reviews[0].title, 'Insidious: Out of the Further');
  assert.match(batches[0].reviews[0].reason, /^Destination conflict/);
  w.close(); fs.rmSync(logPath, { force: true });
});

test('the same review is announced once; a different reason on the same release is new', async () => {
  const logPath = tmpLog();
  const batches = [];
  const w = createOrganizerWatch({ logPath, debounceMs: 40, onMove() {}, onAttention: batch => batches.push(batch) });
  w.setup();
  fs.appendFileSync(logPath, review());
  await waitFor(() => batches.length >= 1);
  fs.appendFileSync(logPath, review());                        // organizer restarted and re-logged it
  await new Promise(r => setTimeout(r, 200));
  assert.equal(batches.length, 1, 'a repeat of the same case must stay quiet');
  fs.appendFileSync(logPath, review({ reason: 'Movie already exists at /mnt/media/Movies/Insidious (2026)' }));
  assert.equal(await waitFor(() => batches.length >= 2), true, 'a new reason is new information');
  w.close(); fs.rmSync(logPath, { force: true });
});

test('a burst of reviews becomes one notification carrying all of them', async () => {
  const logPath = tmpLog();
  const batches = [];
  const w = createOrganizerWatch({ logPath, debounceMs: 80, onMove() {}, onAttention: batch => batches.push(batch) });
  w.setup();
  for (const n of ['A', 'B', 'C']) fs.appendFileSync(logPath, review({ title: n, source: `Release ${n} (2026)` }));
  await waitFor(() => batches.length >= 1);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].reviews.length, 3);
  w.close(); fs.rmSync(logPath, { force: true });
});

test('the legacy "No confident OMDb match" line still notifies', async () => {
  const logPath = tmpLog();
  const batches = [];
  const w = createOrganizerWatch({ logPath, debounceMs: 40, onMove() {}, onAttention: batch => batches.push(batch) });
  w.setup();
  fs.appendFileSync(logPath, '[2026-10-08 20:42:21] SKIP: No confident OMDb match for: Scream 7 (2026)\n');
  assert.equal(await waitFor(() => batches.length >= 1), true);
  assert.equal(batches[0].legacy, 1);
  assert.deepEqual(batches[0].reviews, []);
  w.close(); fs.rmSync(logPath, { force: true });
});

test('lines written by a test run (Python temp dirs) trigger neither a rescan nor a notification', async () => {
  const logPath = tmpLog();
  let moves = 0; const batches = [];
  const w = createOrganizerWatch({ logPath, debounceMs: 40, onMove: () => { moves++; }, onAttention: batch => batches.push(batch) });
  w.setup();
  fs.appendFileSync(logPath, '[2026-10-16 09:13:37] Moved -> /tmp/tmpab12cd34/Movies/Kraven/Kraven.mkv\n');
  fs.appendFileSync(logPath, review({ source: 'pack', reason: 'Destination conflict: Example.S01E01.mkv -> /tmp/tmp9x8y7z6w/tv/Example/S01E01.mkv' }));
  await new Promise(r => setTimeout(r, 250));
  assert.equal(moves, 0, 'a fixture move must not rescan the real library');
  assert.equal(batches.length, 0, 'a fixture review must not notify anyone');
  w.close(); fs.rmSync(logPath, { force: true });
});

test('ordinary traffic does not raise attention, and moves still rescan', async () => {
  const logPath = tmpLog();
  let moves = 0; const batches = [];
  const w = createOrganizerWatch({ logPath, debounceMs: 40, onMove: () => { moves++; }, onAttention: batch => batches.push(batch) });
  w.setup();
  fs.appendFileSync(logPath, '[2026-10-08 20:00:00] Still watching...\n[2026-10-08 20:01:00] Moved -> /mnt/media/Movies/X (2020)/X (2020).mkv\n');
  assert.equal(await waitFor(() => moves >= 1), true);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(batches.length, 0);
  w.close(); fs.rmSync(logPath, { force: true });
});

test('a review line written in two pieces is still seen once complete', async () => {
  const logPath = tmpLog();
  const batches = [];
  const w = createOrganizerWatch({ logPath, debounceMs: 40, onMove() {}, onAttention: batch => batches.push(batch) });
  w.setup();
  const line = review();
  fs.appendFileSync(logPath, line.slice(0, 60));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(batches.length, 0, 'half a line is not an event');
  fs.appendFileSync(logPath, line.slice(60));
  assert.equal(await waitFor(() => batches.length >= 1), true, 'the completed line must be delivered');
  w.close(); fs.rmSync(logPath, { force: true });
});

test('describeAttention names the release for one event and counts releases for several', () => {
  const { describeAttention, friendlyReason } = createOrganizerWatch;
  assert.deepEqual(describeAttention({ reviews: [], legacy: 1 }),
    { title: 'Organizer needs attention', body: 'A download could not be matched to a title' });
  const one = describeAttention({ reviews: [{ title: 'Spider-Man: Brand New Day', source: 's', reason: 'Movie already exists at /mnt/media/Movies/Spider-Man (2026)' }], legacy: 0 });
  assert.equal(one.title, 'Organizer needs attention');
  assert.match(one.body, /^Spider-Man: Brand New Day: Already in your library/);
  const many = describeAttention({ reviews: [
    { title: 'A', source: 'a', reason: 'Destination conflict: x -> y; source retained' },
    { title: 'A', source: 'a', reason: 'Movie already exists at z' },
    { title: 'B', source: 'b', reason: 'Destination conflict: x -> y' }], legacy: 0 });
  assert.match(many.body, /^2 downloads need review\. First: A: /, 'two releases, three events');
  assert.equal(friendlyReason('Missing or ambiguous season/episode: Gag Reel.mkv; source retained'), 'Could not tell the season or episode (Gag Reel.mkv).');
  assert.equal(friendlyReason('x'.repeat(300)).length, 140, 'unknown reasons are shortened, never dropped');
});
