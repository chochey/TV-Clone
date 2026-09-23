const test = require('node:test');
const assert = require('node:assert');
const createQueue = require('./conversion-queue');
const { withinSchedule } = require('./conversion-queue');

// ── schedule window ──────────────────────────────────────────────────────
const at = (h, m = 0) => new Date(2026, 0, 1, h, m, 0);

test('an empty window means anytime', () => {
  assert.strictEqual(withinSchedule({ start: '', end: '' }, at(3)), true);
  assert.strictEqual(withinSchedule({}, at(3)), true);
  assert.strictEqual(withinSchedule(null, at(3)), true);
});

test('a normal daytime window includes only its own hours', () => {
  const w = { start: '02:00', end: '08:00' };
  assert.strictEqual(withinSchedule(w, at(1, 59)), false);
  assert.strictEqual(withinSchedule(w, at(2, 0)), true);
  assert.strictEqual(withinSchedule(w, at(7, 59)), true);
  assert.strictEqual(withinSchedule(w, at(8, 0)), false, 'end is exclusive');
  assert.strictEqual(withinSchedule(w, at(20)), false);
});

test('a window that wraps past midnight works in both halves', () => {
  // The case that looks obviously right and is off by a whole night if the
  // comparison is written as a simple range check.
  const w = { start: '22:00', end: '06:00' };
  assert.strictEqual(withinSchedule(w, at(23)), true, 'before midnight');
  assert.strictEqual(withinSchedule(w, at(2)), true, 'after midnight');
  assert.strictEqual(withinSchedule(w, at(5, 59)), true);
  assert.strictEqual(withinSchedule(w, at(6, 0)), false);
  assert.strictEqual(withinSchedule(w, at(12)), false, 'midday is outside');
  assert.strictEqual(withinSchedule(w, at(21, 59)), false);
});

test('a malformed window fails open rather than blocking forever', () => {
  // A queue that can never run because someone typed nonsense into a time box
  // is worse than one that ignores the window.
  assert.strictEqual(withinSchedule({ start: 'abc', end: '08:00' }, at(12)), true);
  assert.strictEqual(withinSchedule({ start: '02:00', end: 'xx:yy' }, at(12)), true);
});

test('a zero-width window is treated as no restriction', () => {
  assert.strictEqual(withinSchedule({ start: '03:00', end: '03:00' }, at(15)), true);
});

// ── queue state machine ──────────────────────────────────────────────────
function harness(over = {}) {
  const calls = [];
  const config = {
    pauseWhilePlaying: false,
    schedule: { start: '', end: '' },
    retainedBudgetGB: 400,
    maxFilesPerRun: 200,
    niceness: 19,
    ...over.config,
  };
  let playing = over.playing ?? false;
  const q = createQueue({
    worker: {
      convertContainerOnly: over.convert || (async (f) => {
        calls.push(f);
        return { ok: true, bytesBefore: 100, bytesAfter: 100 };
      }),
      setPaused: over.setPaused,
      killActive: over.killActive || (() => false),
    },
    getConfig: () => config,
    getEligibleFiles: over.getEligibleFiles || (() => ['/a.mkv', '/b.mkv', '/c.mkv']),
    isPlaybackActive: () => playing,
    getFileSize: over.getFileSize,
    getRetainedBytes: over.getRetainedBytes || (() => 0),
    onBatchComplete: over.onBatchComplete || (() => {}),
    log: () => {},
    // setImmediate, not Promise.resolve(): an instantly-resolving sleep makes
    // the parked loop spin as a tight microtask chain that never yields to the
    // test's own assertions. Yielding to the macrotask queue keeps the retry
    // loop honest AND lets the test observe it.
    sleep: over.sleep || (() => new Promise((r) => setImmediate(r))),
    now: over.now,
  });
  return { q, calls, config, setPlaying: (v) => { playing = v; } };
}

const settle = () => new Promise((r) => setImmediate(r));

test('start queues eligible files and reports idle when finished', async () => {
  const { q, calls } = harness();
  const res = q.start();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.queued, 3);
  await settle(); await settle(); await settle(); await settle();
  assert.deepStrictEqual(calls, ['/a.mkv', '/b.mkv', '/c.mkv']);
  const s = q.snapshot();
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.converted, 3);
  assert.strictEqual(s.failed, 0);
});

test('start refuses when nothing is eligible', () => {
  const { q } = harness({ getEligibleFiles: () => [] });
  const res = q.start();
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Nothing eligible/);
});

test('maxFilesPerRun caps the queue without hiding that it did', () => {
  const { q } = harness({
    config: { maxFilesPerRun: 2 },
    getEligibleFiles: () => ['/a.mkv', '/b.mkv', '/c.mkv', '/d.mkv'],
  });
  const res = q.start();
  assert.strictEqual(res.queued, 2);
  assert.strictEqual(res.eligible, 4, 'the caller can see how many were left out');
});

test('a failing conversion is counted, not fatal to the run', async () => {
  const { q } = harness({
    convert: async (f) => (f === '/b.mkv'
      ? { ok: false, reason: 'corrupt' }
      : { ok: true, bytesBefore: 1, bytesAfter: 1 }),
  });
  q.start();
  await settle(); await settle(); await settle(); await settle();
  const s = q.snapshot();
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.converted, 2);
  assert.strictEqual(s.failed, 1);
  assert.ok(s.results.some((r) => !r.ok && r.reason === 'corrupt'));
});

test('pause stops advancing and resume continues from the same cursor', async () => {
  let resolveFirst;
  const gate = new Promise((r) => { resolveFirst = r; });
  let n = 0;
  const { q, calls } = harness({
    convert: async (f) => {
      n++;
      if (n === 1) await gate;
      calls.push(f);
      return { ok: true, bytesBefore: 1, bytesAfter: 1 };
    },
  });
  q.start();
  await settle();
  q.pause();
  assert.strictEqual(q.snapshot().status, 'paused');
  resolveFirst();
  await settle(); await settle();
  // The in-flight file completed; nothing after it started.
  assert.strictEqual(q.snapshot().status, 'paused');
  assert.strictEqual(q.snapshot().done, 1);

  q.resume();
  await settle(); await settle(); await settle();
  assert.strictEqual(q.snapshot().status, 'idle');
  assert.strictEqual(q.snapshot().done, 3, 'resumed from where it paused, not from the start');
});

test('pause and resume reject nonsensical transitions', () => {
  const { q } = harness();
  assert.strictEqual(q.pause().ok, false, 'cannot pause an idle queue');
  assert.strictEqual(q.resume().ok, false, 'cannot resume an idle queue');
});

test('stop kills the in-flight conversion and ends the run', async () => {
  let killed = false;
  let finishConvert;
  const { q, calls } = harness({
    // Mirrors reality: the conversion only settles once ffmpeg is killed, and
    // the worker catches that internally and reports an ordinary failure.
    convert: (f) => new Promise((res) => {
      calls.push(f);
      finishConvert = () => res({ ok: false, reason: 'killed' });
    }),
    killActive: () => { killed = true; finishConvert(); return true; },
  });
  q.start();
  await settle();
  const res = q.stop();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(killed, true, 'stop must actually kill ffmpeg, not just set a flag');
  assert.strictEqual(res.killedInFlight, true);
  await settle(); await settle();
  const s = q.snapshot();
  assert.strictEqual(s.status, 'idle', 'must settle to idle, not sit on "stopping"');
  assert.strictEqual(s.failed, 0, 'a killed file is untouched, so it is not a failure');
  assert.strictEqual(calls.length, 1, 'must not start the next file after a stop');
});

test('stopping a paused queue settles to idle even with no loop running', () => {
  // A paused queue has no loop to notice the stopping flag, so stop() must
  // finish the job itself or the UI would sit on "stopping" forever.
  const { q } = harness();
  q.start();
  q.pause();
  q.stop();
  assert.strictEqual(q.snapshot().status, 'idle');
});

test('the queue parks while someone is watching instead of converting', async () => {
  const { q, calls, setPlaying } = harness({
    config: { pauseWhilePlaying: true },
    playing: true,
  });
  q.start();
  await settle(); await settle();
  assert.strictEqual(calls.length, 0, 'nothing converted while playback is active');
  assert.match(q.snapshot().waitingReason, /watching/);

  setPlaying(false);
  await settle(); await settle(); await settle(); await settle();
  assert.strictEqual(q.snapshot().waitingReason, '');
  assert.ok(calls.length > 0, 'resumes on its own once playback ends');
});

test('the queue parks when the retention budget is already full', async () => {
  const { q, calls } = harness({
    config: { retainedBudgetGB: 1 },
    getRetainedBytes: () => 5e9,           // 5 GB held against a 1 GB budget
  });
  q.start();
  await settle(); await settle();
  assert.strictEqual(calls.length, 0);
  assert.match(q.snapshot().waitingReason, /retention budget/);
  q.stop();                                 // this block never clears on its own
  await settle(); await settle();
});

test('the queue parks outside the schedule window', async () => {
  const { q, calls } = harness({
    config: { schedule: { start: '02:00', end: '03:00' } },
    now: () => at(14),                      // well outside
  });
  q.start();
  await settle(); await settle();
  assert.strictEqual(calls.length, 0);
  assert.match(q.snapshot().waitingReason, /window/);
  q.stop();
  await settle(); await settle();
});

test('onBatchComplete fires once per run, and only when something converted', async () => {
  let fired = 0;
  const { q } = harness({ onBatchComplete: () => { fired++; } });
  q.start();
  await settle(); await settle(); await settle(); await settle();
  assert.strictEqual(fired, 1);

  let firedNone = 0;
  const b = harness({
    convert: async () => ({ ok: false, reason: 'nope' }),
    onBatchComplete: () => { firedNone++; },
  });
  b.q.start();
  await settle(); await settle(); await settle(); await settle();
  assert.strictEqual(firedNone, 0, 'no rescan needed when nothing changed on disk');
});

test('starting an already-running queue is refused rather than doubling it', async () => {
  let finish;
  const { q } = harness({
    convert: () => new Promise((res) => { finish = () => res({ ok: true, bytesBefore: 1, bytesAfter: 1 }); }),
    killActive: () => { finish(); return true; },
  });
  q.start();
  await settle();
  const second = q.start();
  assert.strictEqual(second.ok, false);
  assert.match(second.error, /Already running/);
  q.stop();
  await settle(); await settle();
});

test('start on a paused queue resumes it instead of restarting from zero', async () => {
  let resolveFirst;
  const gate = new Promise((r) => { resolveFirst = r; });
  let n = 0;
  const { q } = harness({
    convert: async () => { n++; if (n === 1) await gate; return { ok: true, bytesBefore: 1, bytesAfter: 1 }; },
  });
  q.start();
  await settle();
  q.pause();
  resolveFirst();
  await settle(); await settle();
  const doneWhilePaused = q.snapshot().done;
  q.start();                                 // pressing Start while paused
  await settle(); await settle(); await settle();
  assert.ok(q.snapshot().done >= doneWhilePaused, 'must not rewind progress');
});

test('disabled conversion cannot start', () => {
 const {q,calls}=harness({config:{enabled:false}});
 assert.strictEqual(q.start().ok,false);assert.strictEqual(calls.length,0);
});
test('stop of a paused in-flight job blocks a new run until it settles', async () => {
 let finish;const pauses=[];
 const {q}=harness({convert:()=>new Promise(resolve=>finish=resolve),setPaused:value=>pauses.push(value),killActive:()=>true});
 q.start();await settle();q.pause();assert.ok(pauses.includes(true));
 q.stop();assert.strictEqual(q.snapshot().status,'stopping');assert.strictEqual(q.start().ok,false);
 finish({ok:false,reason:'stopped'});await settle();assert.strictEqual(q.snapshot().status,'idle');
});
test('retention budget includes the next original before starting it',async()=>{
 const {q,calls}=harness({config:{retainedBudgetGB:1},getRetainedBytes:()=>0,getFileSize:()=>2e9});
 q.start();await settle();assert.strictEqual(calls.length,0);assert.match(q.snapshot().waitingReason,/budget/);q.stop();await settle();
});

test('watching override resumes a parked queue but still respects the schedule',async()=>{
 const {q,calls,config}=harness({playing:true,now:()=>at(12),config:{pauseWhilePlaying:true}});
 q.start();await settle();assert.equal(calls.length,0);
 config.pauseWhilePlaying=false;config.schedule={start:'02:00',end:'03:00'};
 q.configurationChanged();await settle();assert.equal(calls.length,0);
 config.schedule={start:'',end:''};q.configurationChanged();
 await settle();await settle();assert.equal(calls.length,3);
});
