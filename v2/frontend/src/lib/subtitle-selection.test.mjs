import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forcedEnglishSubtitle } from './subtitle-selection.js';
test('foreign dialogue defaults to English forced, never full SDH or another language', () => {
 assert.equal(forcedEnglishSubtitle(),-1);
 assert.equal(forcedEnglishSubtitle([{lang:'eng',forced:false},{lang:'spa',forced:true}]),-1);
 assert.equal(forcedEnglishSubtitle([{lang:'eng',forced:false},{lang:'eng',forced:true,bitmap:true}]),1);
 assert.equal(forcedEnglishSubtitle([{lang:'eng',forced:true,bitmap:true},{lang:'en',forced:true,bitmap:false}]),1);
});
