import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalDriveWarnings } from './storage-warnings.js';
test('a nearly full physical drive stays visible when pooled storage has ample free space', () => {
  const warnings = physicalDriveWarnings([
    { mount: '/mnt/media', source: 'mergerfs', percent: 60, available: 3e12 },
    { mount: '/mnt/drive1', source: '/dev/sda1', percent: 96, available: 20e9 },
    { mount: '/mnt/drive2', source: '/dev/sdb1', percent: 50, available: 1e12 },
  ]);
  assert.equal(warnings.length, 1); assert.equal(warnings[0].mount, '/mnt/drive1'); assert.equal(warnings[0].available, 20e9);
});
test('storage API drive rows use the same warning threshold and critical-first order', () => {
  const warnings = physicalDriveWarnings([{ mount: 'a', label: 'Drive A', pct: 90, avail: 1 }, { mount: 'b', pct: 98, avail: 2 }, { mount: 'c', pct: 89 }]);
  assert.deepEqual(warnings.map(w => w.mount), ['b', 'a']); assert.equal(warnings[1].label, 'Drive A');
});
