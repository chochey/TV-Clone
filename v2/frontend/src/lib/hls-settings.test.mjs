import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsSettings } from './hls-settings.js';

test('the player buffers two minutes ahead, up to ten as room allows, within 150 MB', () => {
  const s = hlsSettings({ startupFragments: 3, worker: true });
  assert.equal(s.maxBufferLength, 120);
  assert.equal(s.maxMaxBufferLength, 600);
  assert.equal(s.maxBufferSize, 150 * 1000 * 1000);
});

test('watched video beyond the last 30 seconds is let go, making room ahead', () => {
  assert.equal(hlsSettings({ startupFragments: 3, worker: true }).backBufferLength, 30);
});

test('start-up and recovery settings are unchanged', () => {
  const s = hlsSettings({ startupFragments: 4, worker: false });
  assert.deepEqual({ ...s, maxBufferLength: 0, maxMaxBufferLength: 0, maxBufferSize: 0, backBufferLength: 0 }, {
    maxBufferLength: 0, maxMaxBufferLength: 0, maxBufferSize: 0, backBufferLength: 0,
    startFragPrefetch: true, startPosition: 0, initialLiveManifestSize: 4,
    highBufferWatchdogPeriod: 2, nudgeOffset: 0.2, nudgeMaxRetry: 5, enableWorker: false,
    fragLoadingTimeOut: 30000, fragLoadingMaxRetry: 4, fragLoadingRetryDelay: 1000, autoStartLoad: false,
  });
});
