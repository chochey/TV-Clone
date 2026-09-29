import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshLoop } from './refresh-loop.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
const flush = () => new Promise(r=>setImmediate(r));
function fixture(over={}) {
  let id=0; const jobs=new Map(), listeners=new Set();
  const doc={visibilityState:'visible',addEventListener(_,fn){listeners.add(fn);},removeEventListener(_,fn){listeners.delete(fn);}};
  const timers={setTimeout(fn){jobs.set(++id,fn);return id;},clearTimeout(id){jobs.delete(id);}};
  const loop=createRefreshLoop({load:()=>[],onData(){},interval:()=>15,documentTarget:doc,timers,...over});
  return {loop,jobs,doc,listeners};
}
test('leaving while loading prevents late publication and creation of a poll timer',async()=>{
  const gate=deferred();let published=0;
  const f=fixture({load:()=>gate.promise,onData:()=>published++});
  const work=f.loop.refresh();await flush();f.loop.stop();gate.resolve([]);await work;
  assert.equal(published,0);assert.equal(f.jobs.size,0);assert.equal(f.listeners.size,0);
});
test('refreshes are sequential and only the newest requested result is published',async()=>{
  const first=deferred();let calls=0;const seen=[];
  const f=fixture({load:()=>++calls===1?first.promise:'new',onData:v=>seen.push(v)});
  f.loop.refresh();await flush();f.loop.refresh();f.loop.refresh();assert.equal(calls,1);
  first.resolve('stale');await flush();await flush();assert.equal(calls,2);assert.deepEqual(seen,['new']);f.loop.stop();
});
test('hidden pages stop polling and refresh when visible again',async()=>{
  let calls=0;const f=fixture({load:()=>++calls});await f.loop.refresh();assert.equal(f.jobs.size,1);
  f.doc.visibilityState='hidden';for(const fn of f.listeners)fn();assert.equal(f.jobs.size,0);
  await f.loop.refresh();assert.equal(calls,1);
  f.doc.visibilityState='visible';for(const fn of f.listeners)fn();await flush();assert.equal(calls,2);f.loop.stop();
});
