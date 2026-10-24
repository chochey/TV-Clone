const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createDashboardJobs = require('./dashboard-jobs');

function fixture(t, over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'transcribe'), readAlong = path.join(root, 'read-along'), lite = path.join(root, 'audio-lite');
  for (const d of [work, readAlong, lite, path.join(work, 'books', 'b2')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify([
    { id: 'b1', title: 'Book One', chapters: 10 }, { id: 'b2', title: 'Book Two', chapters: 40 },
    { id: 'b3', title: 'Book Three', chapters: 20 }, { id: 'b4', title: 'Book Four', chapters: 5 }]));
  fs.writeFileSync(path.join(readAlong, 'b1.json'), '{}');
  for (const n of ['01', '02', '03']) fs.writeFileSync(path.join(work, 'books', 'b2', `words-${n}.json`), '[]');
  fs.writeFileSync(path.join(work, 'books', 'b2', 'job.json'), '{}');
  fs.writeFileSync(path.join(lite, 'x.opus.webm'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(lite, 'y.mp3.mp3'), Buffer.alloc(500));
  fs.writeFileSync(path.join(lite, 'x.opus.json'), '{}');
  const jobs = createDashboardJobs({
    transcribeDir: work, readAlongDir: readAlong, audioLiteDir: lite,
    isActive: async unit => unit === 'tvclone-transcribe.service',
    collections: () => ({ films: 600, inCollections: 229, lastAskedAt: 123 }),
    sprites: () => ({ running: false, total: 10, completed: 10, current: '', enabled: true }),
    dataSaver: () => ({ running: null, queued: 0 }),
    libraryScan: () => ({ running: false, phase: 'idle', lastCompletedAt: 456 }),
    ...over,
  });
  return { jobs, work, readAlong };
}

test('transcription progress: books done, the current book chapter by chapter, and what is next', async t => {
  const { jobs } = fixture(t);
  const { transcription } = await jobs.snapshot();
  assert.deepEqual(transcription, { active: true, booksTotal: 4, booksDone: 1,
    current: { title: 'Book Two', chaptersDone: 3, chaptersTotal: 40 }, next: ['Book Three', 'Book Four'] });
});

test('the other jobs are reported as their services describe them, with Data Saver disk use', async t => {
  const { jobs } = fixture(t);
  const s = await jobs.snapshot();
  assert.deepEqual(s.collections, { films: 600, inCollections: 229, lastAskedAt: 123 });
  assert.equal(s.sprites.completed, 10);
  assert.deepEqual(s.dataSaver, { running: null, queued: 0, copies: 2, bytes: 1500 });
  assert.equal(s.libraryScan.lastCompletedAt, 456);
});

test('one broken source never hides the others', async t => {
  const { jobs, work } = fixture(t, { sprites: () => { throw new Error('boom'); } });
  fs.rmSync(path.join(work, 'queue.json'));
  const s = await jobs.snapshot();
  assert.deepEqual(s.transcription, { active: true, booksTotal: 0, booksDone: 0, current: null, next: [] });
  assert.deepEqual(s.sprites, { error: 'unavailable' });
  assert.equal(s.collections.films, 600);
});

// The nightly backup leaves a receipt in the data folder (lib/reliability.js); the dashboard reads it.
test('the backup receipt is reported with its age and whether it sits on the media pool; no receipt says so', async t => {
  const now = Date.parse('2026-10-22T09:19:00Z');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = fixture(t, { dataDir: root, now: () => now });
  assert.deepEqual((await missing.jobs.snapshot()).backup, { missing: true });
  fs.writeFileSync(path.join(root, 'backup-receipt.json'), JSON.stringify({ at: '2026-10-22T07:19:31.000Z', ok: true, verified: true,
    target: '/pool/important/snapshots/2026-10-22T07-19-31-000Z-abc', backupRoot: '/pool/important/snapshots', fileCount: 118, bytes: 334000000, kept: 14, pruned: 1 }));
  const fresh = fixture(t, { dataDir: root, now: () => now, poolRoots: ['/pool'] });
  assert.deepEqual((await fresh.jobs.snapshot()).backup, { at: Date.parse('2026-10-22T07:19:31.000Z'), ok: true, verified: true, error: null,
    where: '/pool/important/snapshots', fileCount: 118, bytes: 334000000, kept: 14, onPool: true, ageHours: 2, stale: false, copy: null, offDisk: true });
  fs.writeFileSync(path.join(root, 'backup-receipt.json'), JSON.stringify({ at: '2026-10-19T07:19:31.000Z', ok: false, error: 'BACKUP_DIRECTORY', target: null, backupRoot: '/srv/app/data_backups' }));
  const old = (await fixture(t, { dataDir: root, now: () => now, poolRoots: ['/pool'] }).jobs.snapshot()).backup;
  assert.equal(old.ok, false); assert.equal(old.error, 'BACKUP_DIRECTORY'); assert.equal(old.onPool, false); assert.equal(old.stale, true); assert.equal(old.ageHours, 74);
});

test('an encrypted copy on the pool counts as a copy off the system disk; a failed or missing one does not', async t => {
  const now = Date.parse('2026-10-24T09:00:00Z');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = copy => fs.writeFileSync(path.join(root, 'backup-receipt.json'), JSON.stringify({ at: '2026-10-24T07:27:29.000Z', ok: true, verified: true,
    backupRoot: '/home/blue/repo/data_backups', fileCount: 84, bytes: 195000000, kept: 14, copy }));
  const read = async () => (await fixture(t, { dataDir: root, now: () => now, poolRoots: ['/pool'] }).jobs.snapshot()).backup;
  write({ ok: true, dir: '/pool/important/encrypted', file: 'x.tvbackup', bytes: 40000000, kept: 3 });
  let b = await read();
  assert.equal(b.onPool, false);
  assert.deepEqual(b.copy, { ok: true, onPool: true, error: null, bytes: 40000000, kept: 3 });
  assert.equal(b.offDisk, true);
  write({ ok: false, dir: '/pool/important/encrypted', error: 'NO_KEY' });
  b = await read();
  assert.deepEqual(b.copy, { ok: false, onPool: true, error: 'NO_KEY', bytes: 0, kept: 0 });
  assert.equal(b.offDisk, false);
  write(undefined);
  b = await read();
  assert.equal(b.copy, null); assert.equal(b.offDisk, false);
});
