const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { people, busyItems, playingSentence, restartRefusal, runningGameServers, createActivity } = require('./activity');

const NOW = 1_800_000_000_000;
const profiles = [
  { id: 'admin', name: 'Admin' }, { id: 'kyle', name: 'Kyle' }, { id: 'mom', name: 'Mom' }, { id: 'kid', name: 'Kid' },
];
const isAudio = id => id.startsWith('book');

test('people: players first with what they play, then everyone else with the site open; stale plays are not playing', () => {
  const r = people({
    profiles,
    presence: { kyle: 1, mom: 2, admin: 1 },
    nowWatching: {
      kyle: { id: 'book1', title: 'Dungeon Crawler Carl, Book 1', currentTime: 30, duration: 100, updatedAt: NOW - 5_000 },
      admin: { id: 'ep11', title: 'The Sopranos - S01E11', currentTime: 45, duration: 100, updatedAt: NOW - 20_000 },
      kid: { id: 'film', title: 'Old', currentTime: 1, duration: 100, updatedAt: NOW - 61_000 },
    },
    isAudio, now: NOW,
  });
  assert.deepEqual(r.counts, { online: 3, watching: 1, listening: 1 });
  assert.deepEqual(r.people, [
    { name: 'Kyle', doing: 'listening', title: 'Dungeon Crawler Carl, Book 1', percent: 30, itemId: 'book1' },
    { name: 'Admin', doing: 'watching', title: 'The Sopranos - S01E11', percent: 45, itemId: 'ep11' },
    { name: 'Mom', doing: 'browsing' },
  ]);
});

test('people: someone playing with no page open still counts, and an unknown profile with a page open does not', () => {
  const r = people({
    profiles, presence: { ghost: 1 },
    nowWatching: { kyle: { id: 'book1', title: 'Carl', currentTime: 0, duration: 0, updatedAt: NOW, profileName: 'Kyle' } },
    isAudio, now: NOW,
  });
  assert.deepEqual(r.counts, { online: 1, watching: 0, listening: 1 });
  assert.deepEqual(r.people, [{ name: 'Kyle', doing: 'listening', title: 'Carl', percent: null, itemId: 'book1' }]);
  assert.deepEqual(people({ profiles, presence: {}, nowWatching: {}, isAudio, now: NOW }), { counts: { online: 0, watching: 0, listening: 0 }, people: [] });
});

test('busyItems names only what is running, in words', () => {
  assert.deepEqual(busyItems({
    downloads: 2,
    conversion: { status: 'running', current: 'The Strain - S01E05 - Runaways.mkv' },
    organizer: { activity: { state: 'copying', detail: 'Copying The Strain - S04E10' } },
    scan: { running: true },
    backup: true, parity: true, transcription: true,
    games: ['Satisfactory', 'Palworld'],
  }), [
    { key: 'downloads', label: 'Downloads', detail: '2 downloading' },
    { key: 'conversion', label: 'Conversion', detail: 'Converting The Strain - S01E05 - Runaways' },
    { key: 'organizer', label: 'Organizer', detail: 'Copying The Strain - S04E10' },
    { key: 'scan', label: 'Library scan', detail: 'Scanning the library' },
    { key: 'backup', label: 'Nightly backup', detail: 'Running now' },
    { key: 'parity', label: 'Parity sync', detail: 'Syncing now' },
    { key: 'transcription', label: 'Read-along', detail: 'Transcribing audiobooks' },
    { key: 'games', label: 'Game servers', detail: 'Satisfactory, Palworld' },
  ]);
  assert.deepEqual(busyItems({
    downloads: 0, conversion: { status: 'idle' }, organizer: { activity: { state: 'idle' } }, scan: { running: false },
    backup: false, parity: false, transcription: false, games: [],
  }), []);
  assert.deepEqual(busyItems({ downloads: 1, organizer: { activity: { state: 'waiting', detail: '' } }, conversion: { status: 'running', current: null } }), [
    { key: 'downloads', label: 'Downloads', detail: '1 downloading' },
    { key: 'conversion', label: 'Conversion', detail: 'Converting' },
    { key: 'organizer', label: 'Organizer', detail: 'Waiting' },
  ]);
  // A conversion run that is only waiting (someone is watching, outside its hours) is doing no work.
  assert.deepEqual(busyItems({ conversion: { status: 'running', current: null, waitingReason: 'someone is watching' } }), []);
});

test('playingSentence and restartRefusal say who a restart would cut off, and force goes ahead', () => {
  assert.equal(playingSentence({ watching: 0, listening: 0 }), '');
  assert.equal(playingSentence({ watching: 0, listening: 1 }), 'Someone is listening right now.');
  assert.equal(playingSentence({ watching: 1, listening: 0 }), 'Someone is watching right now.');
  assert.equal(playingSentence({ watching: 2, listening: 0 }), '2 people are watching right now.');
  assert.equal(playingSentence({ watching: 0, listening: 3 }), '3 people are listening right now.');
  assert.equal(playingSentence({ watching: 1, listening: 1 }), '2 people are watching or listening right now.');
  assert.equal(restartRefusal({ force: false, playing: { watching: 0, listening: 0 } }), null);
  assert.equal(restartRefusal({ force: true, playing: { watching: 1, listening: 0 } }), null);
  assert.deepEqual(restartRefusal({ force: false, playing: { watching: 0, listening: 1 } }),
    { ok: false, playing: { watching: 0, listening: 1 }, error: 'Someone is listening right now.' });
});

test('runningGameServers reads process names from /proc', async t => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-proc-'));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  for (const [pid, comm] of [['101', 'FactoryServer-L'], ['102', 'bash'], ['103', 'valheim_server.'], ['104', 'FactoryServer.s']]) {
    fs.mkdirSync(path.join(proc, pid)); fs.writeFileSync(path.join(proc, pid, 'comm'), `${comm}\n`);
  }
  fs.mkdirSync(path.join(proc, 'self'));
  fs.mkdirSync(path.join(proc, '105'));   // a process that exited: no comm to read
  assert.deepEqual(await runningGameServers({ procDir: proc }), ['Satisfactory', 'Valheim']);
  assert.deepEqual(await runningGameServers({ procDir: path.join(proc, 'missing') }), []);
});

test('createActivity: people are always fresh, the busy list is cached, and one failing source hides nothing else', async () => {
  let clock = NOW; const calls = { downloads: 0 };
  const watching = {};
  const activity = createActivity({
    profiles: () => profiles, presence: () => ({ mom: 1 }), nowWatching: () => watching, isAudio,
    busy: {
      downloads: async () => { calls.downloads++; return 1; },
      games: async () => { throw new Error('proc unreadable'); },
      backup: async () => true,
    },
    now: () => clock, cacheMs: 15_000,
  });
  const first = await activity.snapshot();
  assert.deepEqual(first.counts, { online: 1, watching: 0, listening: 0 });
  assert.deepEqual(first.busy.map(b => b.key), ['downloads', 'backup']);
  watching.kyle = { id: 'book1', title: 'Carl', currentTime: 1, duration: 2, updatedAt: clock };
  const second = await activity.snapshot();
  assert.deepEqual(second.counts, { online: 2, watching: 0, listening: 1 });
  assert.equal(calls.downloads, 1);
  assert.deepEqual(activity.playing(), { watching: 0, listening: 1 });
  clock += 61_000;   // past both the cache and the one-minute playing window
  await activity.snapshot();
  assert.equal(calls.downloads, 2);
  assert.deepEqual(activity.playing(), { watching: 0, listening: 0 });
});
