import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadSearch } from './download-search.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(overrides={}) {
 const state={}, stopped=[], jobs=[];
 const api={searchStart:async()=>({id:1}),searchStop:async id=>stopped.push(id),searchResults:async()=>({results:[],total:0,status:'Stopped'}),...overrides};
 const search=createDownloadSearch(api,patch=>Object.assign(state,patch),{setTimeout:fn=>{jobs.push(fn);return jobs.length;},clearTimeout:()=>{}});
 return {search,state,stopped,jobs};
}
test('late older search is stopped and cannot replace newer results',async()=>{
 const a=deferred(),b=deferred();let count=0;
 const f=fixture({searchStart:()=>++count===1?a.promise:b.promise,searchResults:async id=>({results:[{fileUrl:String(id)}],total:1,status:'Stopped'})});
 const first=f.search.start('first');const second=f.search.start('second');
 b.resolve({id:2});await second;a.resolve({id:1});await first;
 assert.deepEqual(f.state.results,[{fileUrl:'2'}]);assert.ok(f.stopped.includes(1));
});
test('stale poll cannot update or stop the current search',async()=>{
 const pending=deferred();let count=0;
 const f=fixture({searchStart:async()=>({id:++count}),searchResults:id=>id===1?pending.promise:Promise.resolve({results:[{fileUrl:'new'}],total:1,status:'Running'})});
 const first=f.search.start('old');await Promise.resolve();await f.search.start('new');
 pending.resolve({results:[{fileUrl:'old'}],total:1,status:'Stopped'});await first;
 assert.equal(f.state.searching,true);assert.equal(f.state.results[0].fileUrl,'new');assert.ok(!f.stopped.includes(2));f.search.stop();
});
test('fetches multiple pages and deduplicates identical download URLs',async()=>{
 const offsets=[];const f=fixture({searchResults:async(id,limit,offset)=>{
  offsets.push(offset);return {total:201,status:'Stopped',results:offset===0?Array.from({length:200},(_,i)=>({fileUrl:String(i)})):[{fileUrl:'0'}]};
 }});
 await f.search.start('many');assert.deepEqual(offsets,[0,200]);assert.equal(f.state.results.length,200);assert.equal(f.state.total,201);
});
test('page teardown invalidates a pending search start',async()=>{
 const pending=deferred();const f=fixture({searchStart:()=>pending.promise});
 const start=f.search.start('query');f.search.stop();pending.resolve({id:3});await start;
 assert.equal(f.state.searching,false);assert.deepEqual(f.stopped,[3]);
});
test('poll error retains results and retries before giving up',async()=>{
 let calls=0;const f=fixture({searchResults:async()=>{if(calls++)throw new Error('offline');return {results:[{fileUrl:'kept'}],total:1,status:'Running'};}});
 await f.search.start('query');await f.jobs.shift()();assert.equal(f.state.results[0].fileUrl,'kept');assert.match(f.state.error,/offline/);f.search.stop();
});
