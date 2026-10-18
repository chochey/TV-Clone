import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBTITLE_LANGUAGES, subtitleFileProblem, waitForSubtitle } from './subtitle-upload.js';

test('English is offered first and every language has a three-letter code', () => {
  assert.deepEqual(SUBTITLE_LANGUAGES[0], { code: 'eng', label: 'English' });
  assert.ok(SUBTITLE_LANGUAGES.every(l => /^[a-z]{3}$/.test(l.code)));
});

test('only .srt and .vtt files up to 2 MB are accepted', () => {
  assert.equal(subtitleFileProblem(null), 'Choose a subtitle file.');
  assert.equal(subtitleFileProblem({ name: 'Heat.SRT', size: 1000 }), '');
  assert.equal(subtitleFileProblem({ name: 'heat.vtt', size: 2 * 1024 * 1024 }), '');
  assert.match(subtitleFileProblem({ name: 'heat.sub', size: 10 }), /\.srt or \.vtt/);
  assert.match(subtitleFileProblem({ name: 'heat.srt', size: 2 * 1024 * 1024 + 1 }), /2 MB/);
  assert.match(subtitleFileProblem({ name: 'heat.srt', size: 0 }), /empty/);
});

test('waiting checks the item until the new subtitle is listed', async () => {
  let calls = 0;
  const load = async () => ({ subtitles: ++calls < 3 ? [{ url: '/subtitle/old' }] : [{ url: '/subtitle/old' }, { url: '/subtitle/abc123' }] });
  assert.equal(await waitForSubtitle({ load, subtitleId: 'abc123', intervalMs: 0, timeoutMs: 1000, sleep: async () => {} }), true);
  assert.equal(calls, 3);
});

test('waiting gives up after the time limit and survives failed checks', async () => {
  let clock = 0;
  const result = await waitForSubtitle({ load: async () => { throw new Error('offline'); }, subtitleId: 'x', intervalMs: 2000, timeoutMs: 10000,
    sleep: async ms => { clock += ms; }, now: () => clock });
  assert.equal(result, false);
});
