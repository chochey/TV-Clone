const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createChildRunner } = require('./media-process');

function children(t) {
  const all = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); return true; };
    all.push(child); return child;
  };
  t.after(() => all.forEach(child => child.emit('close', 0)));
  return { all, spawnFn };
}

test('media runner limits workers and starts queued work only when a child exits', async t => {
  const fake = children(t), runner = createChildRunner({ spawnFn: fake.spawnFn, concurrency: 2 });
  const work = [runner.run('tool', []), runner.run('tool', []), runner.run('tool', [])];
  assert.equal(fake.all.length, 2);
  assert.deepEqual(runner.snapshot(), { active: 2, queued: 1 });
  fake.all[0].stdout.write('first'); fake.all[0].stderr.write('diagnostic'); fake.all[0].emit('close', 0);
  assert.equal(fake.all.length, 3);
  fake.all[1].emit('close', 0); fake.all[2].emit('close', 0);
  const result = await Promise.all(work);
  assert.equal(result[0].stdout, 'first'); assert.equal(result[0].stderr, 'diagnostic');
  assert.deepEqual(runner.snapshot(), { active: 0, queued: 0 });
});

test('media deadline rejects callers but does not free a still-running child slot', async t => {
  const fake = children(t), runner = createChildRunner({ spawnFn: fake.spawnFn, concurrency: 1, timeoutMs: 20, killGraceMs: 10 });
  await assert.rejects(runner.run('tool', []), { code: 'MEDIA_TIMEOUT' });
  assert.equal(runner.snapshot().active, 1);
  await assert.rejects(runner.run('tool', []), { code: 'MEDIA_TIMEOUT' });
  assert.equal(fake.all.length, 1);
  assert.ok(fake.all[0].kills.includes('SIGTERM'));
  assert.ok(fake.all[0].kills.includes('SIGKILL'));
  fake.all[0].emit('close', null, 'SIGKILL');
  assert.deepEqual(runner.snapshot(), { active: 0, queued: 0 });
});

test('media output and error output are both capped and drained', async t => {
  const fake = children(t), runner = createChildRunner({ spawnFn: fake.spawnFn, concurrency: 1, maxStderrBytes: 4 });
  const job = runner.run('tool', []);
  assert.equal(fake.all[0].stderr.listenerCount('data'), 1);
  fake.all[0].stderr.write('exceeds limit');
  await assert.rejects(job, { code: 'MEDIA_OUTPUT_LIMIT' });
  fake.all[0].emit('close', null, 'SIGTERM');
  const second = runner.run('tool', [], { maxStdoutBytes: 4 });
  fake.all[1].stdout.write('exceeds limit');
  await assert.rejects(second, { code: 'MEDIA_OUTPUT_LIMIT' });
});

test('cancelled queued jobs never spawn and the queue has a hard limit', async t => {
  const fake = children(t), runner = createChildRunner({ spawnFn: fake.spawnFn, concurrency: 1, maxQueued: 1 });
  const first = runner.run('tool', []);
  const controller = new AbortController();
  const queued = runner.run('tool', [], { signal: controller.signal });
  await assert.rejects(runner.run('tool', []), { code: 'MEDIA_BUSY' });
  controller.abort(); await assert.rejects(queued, { code: 'ABORT_ERR' });
  assert.equal(runner.snapshot().queued, 0);
  fake.all[0].emit('close', 0); await first;
  assert.equal(fake.all.length, 1);
});
