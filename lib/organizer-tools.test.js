const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOrganizerFixQueue, upsertAlias } = require('./organizer-tools');

test('parseOrganizerFixQueue extracts TV OMDb misses from organizer logs', () => {
  const queue = parseOrganizerFixQueue([
    '[2026-05-22 17:40:33] [TV] Found: SAS.Rogue.Heroes.S01.1080p.BluRay.x265-RARBG',
    "[2026-05-22 17:40:33] Parsed: title='SAS Rogue Heroes', S01E??",
    '[2026-05-22 17:40:33] SKIP: No OMDb match for series: SAS Rogue Heroes',
  ], [{ from: 'SAS Rogue Heroes', to: 'Rogue Heroes', type: 'series' }]);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].type, 'show');
  assert.equal(queue[0].title, 'SAS Rogue Heroes');
  assert.equal(queue[0].source, 'SAS.Rogue.Heroes.S01.1080p.BluRay.x265-RARBG');
  assert.equal(queue[0].suggestedAlias, 'Rogue Heroes');
});

test('upsertAlias replaces an existing title/type pair', () => {
  const aliases = [];
  const first = upsertAlias(aliases, { from: 'SAS Rogue Heroes', to: 'Rogue Heroes', type: 'series' });
  const second = upsertAlias(aliases, { from: 'sas rogue heroes', to: 'Rogue Heroes 2022', type: 'series' });

  assert.equal(aliases.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(aliases[0].to, 'Rogue Heroes 2022');
});
