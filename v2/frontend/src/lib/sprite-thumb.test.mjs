import test from 'node:test';
import assert from 'node:assert/strict';
import { spriteThumbStyle } from './sprite-thumb.js';

const sprite = { cols: 5, rows: 5, width: 160, height: 90, interval: 10, totalSheets: 2 };

test('picks the sheet and tile for a time and scales it up', () => {
  assert.equal(spriteThumbStyle(sprite, 0, 'a b'),
    'background-image:url(/api/sprites/a%20b/0);background-size:1200px 675px;background-position:-0px -0px;width:240px;height:135px');
  // frame 32 -> sheet 1, tile 7 -> column 2, row 1
  assert.match(spriteThumbStyle(sprite, 325, 'x'), /url\(\/api\/sprites\/x\/1\).*background-position:-480px -135px/);
});

test('times past the last frame stay on the last tile', () => {
  assert.match(spriteThumbStyle(sprite, 99999, 'x'), /sprites\/x\/1\).*background-position:-960px -540px/);
});
