const test = require('node:test');
const assert = require('node:assert');
const createQueue = require('./conversion-queue');
const { withinSchedule } = require('./conversion-queue');

// ── schedule window ──────────────────────────────────────────────────────
const at = (h, m = 0) => new Date(2026, 0, 1, h, m, 0);

test('an empty window means anytime', async () => {
  assert.strictEqual(withinSchedule({ start: '', end: '' }, at(3)), true);
  assert.strictEqual(withinSchedule({}, at(3)), true);
  assert.strictEqual(withinSchedule(null, at(3)), true);
});

test('a normal daytime window includes only its own hours', async () => {
  const w = { start: '02:00', end: '08:00' };
  assert.strictEqual(withinSchedule(w, at(1, 59)), false);
  assert.strictEqual(withinSchedule(w, at(2, 0)), true);
  assert.strictEqual(withinSchedule(w, at(7, 59)), true);
  assert.strictEqual(withinSchedule(w, at(8, 0)), false, 'end is exclusive');
  assert.strictEqual(withinSchedule(w, at(20)), false);
});

test('a window that wraps past midnight works in both halves', async () => {
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

test('a malformed window fails open rather than blocking forever', async () => {
  // A queue that can never run because someone typed nonsense into a time box
  // is worse than one that ignores the window.
  assert.strictEqual(withinSchedule({ start: 'abc', end: '08:00' }, at(12)), true);
  assert.strictEqual(withinSchedule({ start: '02:00', end: 'xx:yy' }, at(12)), true);
});

test('a zero-width window is treated as no restriction', async () => {
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
    getFingerprint: over.getFingerprint || (async () => ({dev:1,ino:1,size:100,mtimeMs:1,ctimeMs:1})),
    getMediaId: over.getMediaId, loadState: over.loadState, saveState: over.saveState,
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

test('stop during an asynchronous originals lookup never starts a file or parks for a minute', async () => {
  let resolve;
  const gate = new Promise(r => { resolve = r; });
  const {q,calls} = harness({getRetainedBytes:()=>gate, sleep:()=>{throw Error('must not park after stop');}});
  (await q.start()); await settle(); (await q.stop()); resolve(Infinity); await settle();
  assert.equal(q.status,'idle'); assert.deepEqual(calls,[]);
});

test('start queues eligible files and reports idle when finished', async () => {
  const { q, calls } = harness();
  const res = (await q.start());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.queued, 3);
  await settle(); await settle(); await settle(); await settle();
  assert.deepStrictEqual(calls, ['/a.mkv', '/b.mkv', '/c.mkv']);
  const s = q.snapshot();
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.converted, 3);
  assert.strictEqual(s.failed, 0);
});

test('delete-original mode skips retention scanning and budget blocking', async () => {
  const {q,calls}=harness({config:{retainOriginals:false,retainedBudgetGB:1},getRetainedBytes:()=>{throw Error('must not scan');},getFileSize:()=>2e9});
  (await q.start());await settle();await settle();await settle();
  assert.equal(q.status,'idle');assert.equal(calls.length,3);assert.equal(q.snapshot().converted,3);
});

test('failure to delete an old file stops further conversions and exposes the cleanup warning', async () => {
  let calls=0;
  const {q}=harness({convert:async()=>{calls++;return {ok:true,cleanupWarning:'Could not delete old file'};}});
  (await q.start());await settle();await settle();
  assert.equal(calls,1);assert.equal(q.status,'idle');assert.equal(q.snapshot().converted,1);
  assert.match(q.snapshot().lastError,/Could not delete/);assert.match(q.snapshot().results[0].reason,/Could not delete/);
});

test('start refuses when nothing is eligible', async () => {
  const { q } = harness({ getEligibleFiles: () => [] });
  const res = (await q.start());
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Nothing eligible/);
});

test('maxFilesPerRun caps the queue without hiding that it did', async () => {
  const { q } = harness({
    config: { maxFilesPerRun: 2 },
    getEligibleFiles: () => ['/a.mkv', '/b.mkv', '/c.mkv', '/d.mkv'],
  });
  const res = (await q.start());
  assert.strictEqual(res.queued, 2);
  assert.strictEqual(res.eligible, 4, 'the caller can see how many were left out');
  assert.strictEqual(q.snapshot().scope, 'batch');
});

test('Convert all queues beyond the batch cap without changing config or eligibility categories', async () => {
  const files = Array.from({ length: 251 }, (_, i) => `/movie-${i}.mkv`);
  let receivedConfig;
  const { q, calls, config } = harness({
    config: { maxFilesPerRun: 2, tiers: { container: true, audio: false, video: false } },
    getEligibleFiles: cfg => { receivedConfig = cfg; return cfg.tiers.container ? files : []; },
  });
  const before = structuredClone(config);
  assert.strictEqual(q.snapshot().scope, 'batch');
  const result = (await q.start({ all: true }));
  assert.strictEqual(result.queued, 251);
  assert.strictEqual(result.eligible, 251);
  assert.strictEqual(q.snapshot().scope, 'all');
  assert.strictEqual(receivedConfig, config, 'uses the same enabled categories and worker limits');
  await settle();
  assert.deepStrictEqual(calls, files);
  assert.strictEqual(q.snapshot().status, 'idle');
  assert.strictEqual(q.snapshot().converted, 251);
  assert.deepStrictEqual(config, before, 'run scope does not modify persisted settings');

  const batch = (await q.start({ all: false }));
  assert.strictEqual(batch.queued, 2);
  assert.strictEqual(q.snapshot().scope, 'batch', 'a fresh ordinary run restores the batch cap');
  await settle();
});

test('Convert all re-enumerates current eligibility instead of reconverting completed files', async () => {
  const eligible = new Set(['/a.mkv', '/b.mkv', '/c.mkv']);
  const converted = [];
  let scans = 0;
  const { q } = harness({
    config: { maxFilesPerRun: 1 },
    getEligibleFiles: () => { scans++; return [...eligible]; },
    convert: async file => {
      converted.push(file);
      eligible.delete(file); // The library classifier sees verified compatible replacements.
      return { ok: true };
    },
  });
  assert.strictEqual((await q.start({ all: true })).queued, 3);
  await settle();
  assert.deepStrictEqual(converted, ['/a.mkv', '/b.mkv', '/c.mkv']);
  assert.match((await q.start({ all: true })).error, /Nothing eligible/);
  eligible.add('/new.mkv');
  assert.strictEqual((await q.start({ all: true })).queued, 1);
  await settle();
  assert.deepStrictEqual(converted, ['/a.mkv', '/b.mkv', '/c.mkv', '/new.mkv']);
  assert.strictEqual(scans, 3);
});

test('pause and resume preserve an all run and continue beyond the batch cap', async () => {
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const converted = [];
  const { q } = harness({
    config: { maxFilesPerRun: 1 },
    convert: async file => { if (!converted.length) await first; converted.push(file); return { ok: true }; },
  });
  (await q.start({ all: true }));
  await settle();
  (await q.pause());
  assert.strictEqual(q.snapshot().scope, 'all');
  releaseFirst();
  await settle();
  assert.strictEqual(q.snapshot().done, 1);
  assert.strictEqual(q.snapshot().remaining, 2);
  (await q.resume());
  await settle();
  assert.strictEqual(q.snapshot().scope, 'all');
  assert.strictEqual(q.snapshot().status, 'idle');
  assert.deepStrictEqual(converted, ['/a.mkv', '/b.mkv', '/c.mkv']);
});

test('Convert all cannot silently resume a paused capped batch or change its scope', async () => {
  const { q, calls } = harness({ config: { maxFilesPerRun: 1, pauseWhilePlaying: true }, playing: true });
  (await q.start());
  await settle();
  (await q.pause());
  const result = (await q.start({ all: true }));
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Resume.*stop/);
  assert.strictEqual(q.snapshot().scope, 'batch');
  assert.strictEqual(q.snapshot().status, 'paused');
  assert.strictEqual(q.snapshot().total, 1);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual((await q.start()).ok, true, 'ordinary Start retains its existing resume behavior');
  assert.strictEqual(q.snapshot().scope, 'batch');
  (await q.stop());
  await settle();
});

test('stop retains all scope and interrupts without starting more files or counting a failed verification', async () => {
  let finish;
  const started = [];
  const { q } = harness({
    config: { maxFilesPerRun: 1 },
    convert: file => new Promise(resolve => { started.push(file); finish = resolve; }),
    killActive: () => { finish({ ok: false, reason: 'killed' }); return true; },
  });
  (await q.start({ all: true }));
  await settle();
  (await q.pause());
  (await q.resume());
  assert.strictEqual(q.snapshot().scope, 'all');
  (await q.stop());
  await settle();
  assert.strictEqual(q.snapshot().scope, 'all');
  assert.strictEqual(q.snapshot().status, 'idle');
  assert.strictEqual(q.snapshot().failed, 0);
  assert.deepStrictEqual(started, ['/a.mkv']);
  assert.strictEqual((await q.resume()).ok, false, 'Stop ends the run rather than leaving a resumable queue');
});

test('Convert all still refuses disabled or already active conversion', async () => {
  let scans = 0;
  const disabled = harness({ config: { enabled: false }, getEligibleFiles: () => { scans++; return ['/a.mkv']; } });
  assert.strictEqual((await disabled.q.start({ all: true })).ok, false);
  assert.strictEqual(scans, 0);
  assert.strictEqual(disabled.q.snapshot().scope, 'batch');

  const active = harness({ config: { pauseWhilePlaying: true, maxFilesPerRun: 1 }, playing: true });
  (await active.q.start());
  await settle();
  assert.match((await active.q.start({ all: true })).error, /Already running/);
  assert.strictEqual(active.q.snapshot().scope, 'batch');
  assert.strictEqual(active.q.snapshot().total, 1);
  (await active.q.stop());
  await settle();
});

test('all scope preserves playback, schedule, retention, and disabled guards', async () => {
  const cases = [
    { playing: true, config: { pauseWhilePlaying: true }, reason: /watching/ },
    { now: () => at(14), config: { schedule: { start: '02:00', end: '03:00' } }, reason: /window/ },
    { getRetainedBytes: () => 5e9, config: { retainedBudgetGB: 1 }, reason: /retention budget/ },
    { playing: true, config: { pauseWhilePlaying: true }, afterStart: config => { config.enabled = false; }, reason: /disabled/ },
  ];
  for (const options of cases) {
    const { q, calls, config } = harness({ ...options, config: { ...options.config, maxFilesPerRun: 1 } });
    (await q.start({ all: true }));
    await settle();
    if (options.afterStart) { options.afterStart(config); q.configurationChanged(); await settle(); }
    try {
      assert.strictEqual(q.snapshot().scope, 'all');
      assert.strictEqual(q.snapshot().total, 3);
      assert.deepStrictEqual(calls, [], String(options.reason));
      assert.match(q.snapshot().waitingReason, options.reason);
    } finally {
      (await q.stop());
      await settle();
    }
  }
});

test('overlapping library roots cannot queue an exact file twice or waste the batch cap', async () => {
  for (const all of [false, true]) {
    const { q, calls } = harness({
      config: { maxFilesPerRun: 2 },
      getEligibleFiles: () => ['/a.mkv', '/a.mkv', '/b.mkv', '/c.mkv', '/b.mkv'],
    });
    const result = (await q.start({ all }));
    assert.strictEqual(result.eligible, 3);
    assert.strictEqual(result.queued, all ? 3 : 2);
    await settle();
    assert.deepStrictEqual(calls, all ? ['/a.mkv', '/b.mkv', '/c.mkv'] : ['/a.mkv', '/b.mkv']);
  }
});

test('a failing conversion is counted, not fatal to the run', async () => {
  const { q } = harness({
    convert: async (f) => (f === '/b.mkv'
      ? { ok: false, reason: 'corrupt' }
      : { ok: true, bytesBefore: 1, bytesAfter: 1 }),
  });
  (await q.start());
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
  (await q.start());
  await settle();
  (await q.pause());
  assert.strictEqual(q.snapshot().status, 'paused');
  resolveFirst();
  await settle(); await settle();
  // The in-flight file completed; nothing after it started.
  assert.strictEqual(q.snapshot().status, 'paused');
  assert.strictEqual(q.snapshot().done, 1);

  (await q.resume());
  await settle(); await settle(); await settle();
  assert.strictEqual(q.snapshot().status, 'idle');
  assert.strictEqual(q.snapshot().done, 3, 'resumed from where it paused, not from the start');
});

test('pause and resume reject nonsensical transitions', async () => {
  const { q } = harness();
  assert.strictEqual((await q.pause()).ok, false, 'cannot pause an idle queue');
  assert.strictEqual((await q.resume()).ok, false, 'cannot resume an idle queue');
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
  (await q.start());
  await settle();
  const res = (await q.stop());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(killed, true, 'stop must actually kill ffmpeg, not just set a flag');
  assert.strictEqual(res.killedInFlight, true);
  await settle(); await settle();
  const s = q.snapshot();
  assert.strictEqual(s.status, 'idle', 'must settle to idle, not sit on "stopping"');
  assert.strictEqual(s.failed, 0, 'a killed file is untouched, so it is not a failure');
  assert.strictEqual(calls.length, 1, 'must not start the next file after a stop');
});

test('stopping a paused queue settles to idle even with no loop running', async () => {
  // A paused queue has no loop to notice the stopping flag, so stop() must
  // finish the job itself or the UI would sit on "stopping" forever.
  const { q } = harness();
  (await q.start());
  (await q.pause());
  (await q.stop());
  assert.strictEqual(q.snapshot().status, 'idle');
});

test('the queue parks while someone is watching instead of converting', async () => {
  const { q, calls, setPlaying } = harness({
    config: { pauseWhilePlaying: true },
    playing: true,
  });
  (await q.start());
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
  (await q.start());
  await settle(); await settle();
  assert.strictEqual(calls.length, 0);
  assert.match(q.snapshot().waitingReason, /retention budget/);
  (await q.stop());                                 // this block never clears on its own
  await settle(); await settle();
});

test('the queue parks outside the schedule window', async () => {
  const { q, calls } = harness({
    config: { schedule: { start: '02:00', end: '03:00' } },
    now: () => at(14),                      // well outside
  });
  (await q.start());
  await settle(); await settle();
  assert.strictEqual(calls.length, 0);
  assert.match(q.snapshot().waitingReason, /window/);
  (await q.stop());
  await settle(); await settle();
});

test('onBatchComplete fires once per run, and only when something converted', async () => {
  let fired = 0;
  const { q } = harness({ onBatchComplete: () => { fired++; } });
  (await q.start());
  await settle(); await settle(); await settle(); await settle();
  assert.strictEqual(fired, 1);

  let firedNone = 0;
  const b = harness({
    convert: async () => ({ ok: false, reason: 'nope' }),
    onBatchComplete: () => { firedNone++; },
  });
  (await b.q.start());
  await settle(); await settle(); await settle(); await settle();
  assert.strictEqual(firedNone, 0, 'no rescan needed when nothing changed on disk');
});

test('starting an already-running queue is refused rather than doubling it', async () => {
  let finish;
  const { q } = harness({
    convert: () => new Promise((res) => { finish = () => res({ ok: true, bytesBefore: 1, bytesAfter: 1 }); }),
    killActive: () => { finish(); return true; },
  });
  (await q.start());
  await settle();
  const second = (await q.start());
  assert.strictEqual(second.ok, false);
  assert.match(second.error, /Already running/);
  (await q.stop());
  await settle(); await settle();
});

test('start on a paused queue resumes it instead of restarting from zero', async () => {
  let resolveFirst;
  const gate = new Promise((r) => { resolveFirst = r; });
  let n = 0;
  const { q } = harness({
    convert: async () => { n++; if (n === 1) await gate; return { ok: true, bytesBefore: 1, bytesAfter: 1 }; },
  });
  (await q.start());
  await settle();
  (await q.pause());
  resolveFirst();
  await settle(); await settle();
  const doneWhilePaused = q.snapshot().done;
  (await q.start());                                 // pressing Start while paused
  await settle(); await settle(); await settle();
  assert.ok(q.snapshot().done >= doneWhilePaused, 'must not rewind progress');
});

test('disabled conversion cannot start', async () => {
 const {q,calls}=harness({config:{enabled:false}});
 assert.strictEqual((await q.start()).ok,false);assert.strictEqual(calls.length,0);
});
test('stop of a paused in-flight job blocks a new run until it settles', async () => {
 let finish;const pauses=[];
 const {q}=harness({convert:()=>new Promise(resolve=>finish=resolve),setPaused:value=>pauses.push(value),killActive:()=>true});
 (await q.start());await settle();(await q.pause());assert.ok(pauses.includes(true));
 (await q.stop());assert.strictEqual(q.snapshot().status,'stopping');assert.strictEqual((await q.start()).ok,false);
 finish({ok:false,reason:'stopped'});await settle();assert.strictEqual(q.snapshot().status,'idle');
});
test('retention budget includes the next original before starting it',async()=>{
 const {q,calls}=harness({config:{retainedBudgetGB:1},getRetainedBytes:()=>0,getFileSize:()=>2e9});
 (await q.start());await settle();assert.strictEqual(calls.length,0);assert.match(q.snapshot().waitingReason,/budget/);(await q.stop());await settle();
});

test('watching override resumes a parked queue but still respects the schedule',async()=>{
 const {q,calls,config}=harness({playing:true,now:()=>at(12),config:{pauseWhilePlaying:true}});
 (await q.start());await settle();assert.equal(calls.length,0);
 config.pauseWhilePlaying=false;config.schedule={start:'02:00',end:'03:00'};
 q.configurationChanged();await settle();assert.equal(calls.length,0);
 config.schedule={start:'',end:''};q.configurationChanged();
 await settle();await settle();assert.equal(calls.length,3);
});

// Exercise the actual route in isolation; no server, media worker, or network starts.
function startRoute(result = { ok: true }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/conversion/start'");
  const end = source.indexOf("app.post('/api/conversion/pause'", start);
  assert.ok(start >= 0 && end > start, 'conversion start route exists');
  const calls = [];
  const requireAdminSession = () => {};
  let route;
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (url, auth, ...handlers) => { route = { url, auth, handler:handlers.at(-1) }; } },
    requireAdminSession, ensureLibrary: () => {},
    conversionControl: operation => operation(),
    conversionQueue: {
      start: options => { calls.push({ ...options }); return result; },
      snapshot: () => ({ status: 'running', scope: calls.at(-1)?.all ? 'all' : 'batch' }),
    },
  });
  assert.strictEqual(route.url, '/api/conversion/start');
  assert.strictEqual(route.auth, requireAdminSession, 'start remains admin-protected');
  return {
    calls,
    request: async body => {
      const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = { ...value }; return this; },
      };
      await route.handler({ body }, response);
      return response;
    },
  };
}

test('conversion start API accepts boolean all and defaults an absent field to batch', async () => {
  const route = startRoute();
  for (const [body, all] of [[undefined, false], [{}, false], [{ all: false }, false], [{ all: true }, true]]) {
    const response = await route.request(body);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(route.calls.at(-1).all, all);
    assert.strictEqual(response.body.scope, all ? 'all' : 'batch');
  }
});

test('conversion start API rejects malformed provided all before invoking the queue', async () => {
  const route = startRoute();
  for (const all of ['true', 'false', 1, 0, null, [], {}, undefined]) {
    const response = await route.request({ all });
    assert.strictEqual(response.statusCode, 400, String(all));
    assert.strictEqual(response.body.ok, false);
    assert.match(response.body.error, /boolean/);
  }
  assert.deepStrictEqual(route.calls, []);
});

test('conversion start API preserves conflict responses for paused or active runs', async () => {
  const route = startRoute({ ok: false, error: 'Resume the paused run first' });
  const response = await route.request({ all: true });
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(response.body.ok, false);
  assert.strictEqual(response.body.error, 'Resume the paused run first');
});
