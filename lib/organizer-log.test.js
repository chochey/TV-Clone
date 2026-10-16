const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMoves, parseMovedEvent } = require('./organizer-log');

const STAMP = '[2026-10-16 09:00:00] ';
const legacy = (source, destination) => [`${STAMP}Import source: ${source} -> ${destination}`, `${STAMP}Moved -> ${destination}`];
const event = (source, destination, release = 'Pack') =>
  `${STAMP}EVENT: ${JSON.stringify({ event: 'moved', release, source, destination })}`;

test('the older two-line form still yields a completed move', () => {
  assert.deepEqual(parseMoves(legacy('/s/Pack/a.mkv', '/l/a.mkv')), [{ source: '/s/Pack/a.mkv', destination: '/l/a.mkv', release: null }]);
});

test('the typed event alone is a completed move and carries its release', () => {
  assert.deepEqual(parseMoves([event('/s/Pack/a.mkv', '/l/a.mkv')]), [{ source: '/s/Pack/a.mkv', destination: '/l/a.mkv', release: 'Pack' }]);
});

test('a move written both ways counts once, and the typed version wins', () => {
  const lines = [...legacy('/s/Pack/a.mkv', '/l/a.mkv'), event('/s/Pack/a.mkv', '/l/a.mkv')];
  assert.deepEqual(parseMoves(lines), [{ source: '/s/Pack/a.mkv', destination: '/l/a.mkv', release: 'Pack' }]);
});

test('consecutive moves keep their order whichever form each used', () => {
  const lines = [
    ...legacy('/s/Old/a.mkv', '/l/a.mkv'),                                         // before events existed
    ...legacy('/s/Pack/b.mkv', '/l/b.mkv'), event('/s/Pack/b.mkv', '/l/b.mkv'),
    ...legacy('/s/Pack/c.mkv', '/l/c.mkv'), event('/s/Pack/c.mkv', '/l/c.mkv'),
  ];
  assert.deepEqual(parseMoves(lines).map(move => [move.destination, move.release]),
    [['/l/a.mkv', null], ['/l/b.mkv', 'Pack'], ['/l/c.mkv', 'Pack']]);
});

test('an event for a different destination is a different move, not a duplicate', () => {
  const lines = [...legacy('/s/Pack/a.mkv', '/l/a.mkv'), event('/s/Pack/b.mkv', '/l/b.mkv')];
  assert.deepEqual(parseMoves(lines).map(move => move.destination), ['/l/a.mkv', '/l/b.mkv']);
});

test('a planned import that never completed is not a move', () => {
  const lines = [
    `${STAMP}Import source: /s/Pack/a.mkv -> /l/a.mkv`,              // crashed here
    ...legacy('/s/Pack/b.mkv', '/l/b.mkv'),
  ];
  assert.deepEqual(parseMoves(lines).map(move => move.destination), ['/l/b.mkv']);
});

test('a "Moved" line that does not match the planned destination is not trusted', () => {
  assert.deepEqual(parseMoves([`${STAMP}Import source: /s/a.mkv -> /l/a.mkv`, `${STAMP}Moved -> /l/other.mkv`]), []);
  assert.deepEqual(parseMoves([`${STAMP}Moved -> /l/lonely.mkv`]), []);
});

test('lines written by a test run, other event types and damaged events are ignored', () => {
  const lines = [
    ...legacy('/tmp/tmpab12cd34/share/a.mkv', '/tmp/tmpab12cd34/lib/a.mkv'),
    event('/tmp/tmpab12cd34/share/a.mkv', '/tmp/tmpab12cd34/lib/a.mkv'),
    `${STAMP}EVENT: ${JSON.stringify({ event: 'scan', source: '/s/x', destination: '/l/x' })}`,
    `${STAMP}EVENT: ${JSON.stringify({ event: 'moved', source: '/s/only-source.mkv' })}`,
    `${STAMP}EVENT: {"event": "moved", "source": "/s/Pack/trunc`,
    `${STAMP}EVENT: not json`,
    'EVENT: null',
  ];
  assert.deepEqual(parseMoves(lines), []);
});

test('timestamps are optional', () => {
  assert.equal(parseMoves(['Import source: /s/a.mkv -> /l/a.mkv', 'Moved -> /l/a.mkv']).length, 1);
  assert.equal(parseMoves([event('/s/Pack/a.mkv', '/l/a.mkv').replace(STAMP, '')]).length, 1);
});

test('parseMovedEvent reads exactly the moved event', () => {
  assert.deepEqual(parseMovedEvent(`EVENT: ${JSON.stringify({ event: 'moved', release: 'R', source: 's', destination: 'd', extra: 1 })}`),
    { source: 's', destination: 'd', release: 'R' });
  assert.equal(parseMovedEvent('Moved -> /l/a.mkv'), null);
  assert.equal(parseMovedEvent(`EVENT: ${JSON.stringify({ event: 'moved', source: 's', destination: 'd' })}`).release, null);
});
