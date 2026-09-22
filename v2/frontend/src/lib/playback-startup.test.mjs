import test from 'node:test';
import assert from 'node:assert/strict';
import { startPlayback } from './playback-startup.js';
function fixture(play = () => new Promise(() => {}), options = {}) {
  const events = new Map(), jobs = new Map(); let id = 0, played = 0, failed = 0, blocked = 0, current = true;
  const video = { paused: true, readyState: 0, play() { played++; return play(); }, addEventListener(k,v) { events.set(k,v); }, removeEventListener(k,v) { if(events.get(k)===v) events.delete(k); } };
  const timers = { setTimeout(fn) { jobs.set(++id, fn); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const cancel = startPlayback(video,{ isCurrent: () => current, onTimeout() { failed++; }, onBlocked() { blocked++; }, timers, ...options });
  return { video, events, jobs, cancel, get played() { return played; }, get failed() { return failed; }, get blocked() { return blocked; }, stale() { current = false; } };
}
test('startup calls play without canplaythrough and times out even while paused with no decoded data', () => {
  const f=fixture(); assert.equal(f.played,1); [...f.jobs.values()][0](); assert.equal(f.failed,1); assert.equal(f.jobs.size,0);
});
test('playing or cancellation clears startup timeout and event listener', () => {
  for(const finish of ['playing','cancel']) { const f=fixture(); const stale=[...f.jobs.values()][0]; if(finish==='playing') f.events.get('playing')(); else f.cancel(); stale(); assert.equal(f.failed,0); assert.equal(f.jobs.size,0); assert.equal(f.events.size,0); }
});
test('old attempts cannot fall back after seek or player close', () => {
 const f=fixture(); f.stale(); [...f.jobs.values()][0](); assert.equal(f.failed,0);
});
test('autoplay rejection requests user play rather than retrying or claiming decode failure', async () => {
 const f=fixture(() => Promise.reject(Object.assign(new Error('blocked'),{name:'NotAllowedError'})));
 await new Promise(r=>setImmediate(r)); assert.equal(f.blocked,1); assert.equal(f.failed,0); assert.equal(f.jobs.size,0);
});

test('requests autoplay immediately even while no data is buffered', () => {
 const f = fixture();
 assert.equal(f.video.paused, true);
 assert.equal(f.video.readyState, 0);
 assert.equal(f.played, 1);
 assert.equal(f.jobs.size, 1); // only the failure watchdog, no delayed play
 f.cancel();
});
test('a synchronous permission error also offers manual playback', () => {
 const f = fixture(() => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); });
 assert.equal(f.blocked, 1); assert.equal(f.jobs.size, 0);
});
test('an already stale session never requests playback', () => {
 const f = fixture(undefined, { isCurrent: () => false });
 assert.equal(f.played, 0); assert.equal(f.jobs.size, 0);
});
test('a cancelled play rejection cannot affect a new session', async () => {
 let reject;
 const f = fixture(() => new Promise((_, r) => { reject = r; }));
 f.cancel(); reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
 await new Promise(r => setImmediate(r));
 assert.equal(f.blocked, 0); assert.equal(f.failed, 0);
});

test('a fulfilled play request cancels the watchdog even without a playing event', async () => {
 const f = fixture(() => Promise.resolve());
 const lateTimeout = [...f.jobs.values()][0];
 await new Promise(r => setImmediate(r));
 lateTimeout();
 assert.equal(f.failed, 0); assert.equal(f.jobs.size, 0); assert.equal(f.events.size, 0);
});
test('watchdog does not report failure for an element already playing', () => {
 const f = fixture(); f.video.paused = false; f.video.readyState = 3;
 [...f.jobs.values()][0](); assert.equal(f.failed, 0); assert.equal(f.jobs.size, 0);
});
test('an unpaused element still waiting for data does report a startup failure', () => {
 const f = fixture(); f.video.paused = false; f.video.readyState = 2;
 [...f.jobs.values()][0](); assert.equal(f.failed, 1);
});

test('slow startup gives a nonfatal notice and keeps waiting for autoplay', () => {
 let slow=0;const f=fixture(undefined,{onSlow:()=>slow++});
 const [deadline,warning]=[...f.jobs.values()];
 warning();assert.equal(slow,1);assert.equal(f.failed,0);assert.equal(f.played,1);
 f.events.get('playing')();deadline();assert.equal(f.failed,0);assert.equal(f.jobs.size,0);
});
test('a stuck startup remains bounded after the slow notice', () => {
 let slow=0;const f=fixture(undefined,{onSlow:()=>slow++});
 const [deadline,warning]=[...f.jobs.values()];warning();deadline();
 assert.equal(slow,1);assert.equal(f.failed,1);assert.equal(f.jobs.size,0);
});
test('closing the player suppresses a queued slow-start notice', () => {
 let slow=0;const f=fixture(undefined,{onSlow:()=>slow++});
 const warning=[...f.jobs.values()][1];f.cancel();warning();assert.equal(slow,0);
});
