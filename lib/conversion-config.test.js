const test = require('node:test');
const assert = require('node:assert');
const { sanitize, DEFAULTS } = require('./conversion-config');

test('an empty update leaves defaults untouched', () => {
  assert.deepStrictEqual(sanitize({}, DEFAULTS), DEFAULTS);
  assert.deepStrictEqual(sanitize(null, DEFAULTS), DEFAULTS);
});

test('booleans update in place', () => {
  const out = sanitize({ enabled: true, pauseWhilePlaying: false }, DEFAULTS);
  assert.strictEqual(out.enabled, true);
  assert.strictEqual(out.pauseWhilePlaying, false);
});

test('a non-boolean enabled value is rejected, not coerced', () => {
  // "false" the string is truthy — silently accepting it would let a client
  // bug turn the feature on by sending the wrong type.
  const out = sanitize({ enabled: 'true' }, DEFAULTS);
  assert.strictEqual(out.enabled, DEFAULTS.enabled);
});

test('tier toggles update individually without clobbering the others', () => {
  const out = sanitize({ tiers: { legacy: true } }, DEFAULTS);
  assert.strictEqual(out.tiers.legacy, true);
  assert.strictEqual(out.tiers.container, DEFAULTS.tiers.container);
  assert.strictEqual(out.tiers.audio, DEFAULTS.tiers.audio);
});

test('concurrency is clamped into range, not rejected outright', () => {
  assert.strictEqual(sanitize({ concurrency: 99 }, DEFAULTS).concurrency, 4);
  assert.strictEqual(sanitize({ concurrency: 0 }, DEFAULTS).concurrency, 1);
  assert.strictEqual(sanitize({ concurrency: -5 }, DEFAULTS).concurrency, 1);
});

test('niceness is clamped to the valid nice(1) range', () => {
  assert.strictEqual(sanitize({ niceness: 40 }, DEFAULTS).niceness, 19);
  assert.strictEqual(sanitize({ niceness: -20 }, DEFAULTS).niceness, 0);
});

test('non-numeric values fall back to the current setting rather than becoming NaN', () => {
  const current = { ...DEFAULTS, concurrency: 2 };
  const out = sanitize({ concurrency: 'lots' }, current);
  assert.strictEqual(out.concurrency, 2);
  assert.ok(Number.isFinite(out.concurrency));
});

test('schedule accepts two valid HH:MM values', () => {
  const out = sanitize({ schedule: { start: '01:30', end: '07:45' } }, DEFAULTS);
  assert.deepStrictEqual(out.schedule, { start: '01:30', end: '07:45' });
});

test('schedule accepts both empty as "anytime"', () => {
  const out = sanitize({ schedule: { start: '', end: '' } }, DEFAULTS);
  assert.deepStrictEqual(out.schedule, { start: '', end: '' });
});

test('a malformed schedule is rejected wholesale, not half-applied', () => {
  const current = { ...DEFAULTS, schedule: { start: '02:00', end: '08:00' } };
  const out = sanitize({ schedule: { start: '25:99', end: '08:00' } }, current);
  assert.deepStrictEqual(out.schedule, current.schedule);
});

test('minFreeSpaceGB, maxFilesPerRun, keepOriginalsDays, retainedBudgetGB all clamp', () => {
  const out = sanitize({
    minFreeSpaceGB: 1, maxFilesPerRun: 999999, keepOriginalsDays: 0, retainedBudgetGB: -1,
  }, DEFAULTS);
  assert.strictEqual(out.minFreeSpaceGB, 10);
  assert.strictEqual(out.maxFilesPerRun, 2000);
  assert.strictEqual(out.keepOriginalsDays, 1);
  assert.strictEqual(out.retainedBudgetGB, 10);
});

test('unknown keys are dropped silently rather than stored', () => {
  const out = sanitize({ notARealSetting: 'hax', enabled: true }, DEFAULTS);
  assert.strictEqual(out.notARealSetting, undefined);
  assert.strictEqual(out.enabled, true);
});

test('tiers as the wrong shape does not crash and leaves tiers untouched', () => {
  const out = sanitize({ tiers: ['container'] }, DEFAULTS);
  // An array is typeof 'object' but has no boolean-valued container/audio/legacy
  // keys, so every per-tier check should just miss and fall through to current.
  assert.deepStrictEqual(out.tiers, DEFAULTS.tiers);
});
