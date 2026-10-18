import test from 'node:test';
import assert from 'node:assert/strict';
import { playerKeyAction } from './player-keys.js';

const key = (k, extra = {}) => ({ key: k, target: { closest: () => null }, ...extra });

test('playback, seek and volume keys map to actions that stop the page from scrolling', () => {
  for (const [k, action] of [[' ', 'toggle'], ['k', 'toggle'], ['ArrowLeft', 'back'], ['ArrowRight', 'forward'], ['ArrowUp', 'louder'], ['ArrowDown', 'quieter']]) {
    assert.deepEqual(playerKeyAction(key(k)), { action, prevent: true }, k);
  }
});

test('mute, fullscreen and Escape act without blocking the default', () => {
  assert.deepEqual(playerKeyAction(key('m')), { action: 'mute', prevent: false });
  assert.deepEqual(playerKeyAction(key('f')), { action: 'fullscreen', prevent: false });
  assert.deepEqual(playerKeyAction(key('Escape')), { action: 'escape', prevent: false });
});

test('typing in a field, browser shortcuts and other keys are ignored', () => {
  assert.equal(playerKeyAction(key(' ', { target: { closest: sel => (sel === 'input' ? {} : null) } })), null);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(playerKeyAction(key('ArrowRight', { [mod]: true })), null, mod);
  assert.equal(playerKeyAction(key('x')), null);
  assert.equal(playerKeyAction(key('F')), null);
});
