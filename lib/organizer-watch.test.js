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
