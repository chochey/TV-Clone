import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPauseBookmark} from './pause-resume.js';
test('long pause resumes the bookmarked position even if media time resets',()=>{
 const b=createPauseBookmark(); b.capture(1842.5,1000);
 assert.deepEqual(b.take(0,121001),{position:1842.5,expired:true});
 assert.deepEqual(b.take(1843,121002),{position:1843,expired:false});
});
test('short pauses reuse playback and an intentional paused seek updates the bookmark',()=>{
 const b=createPauseBookmark();b.capture(400,1000);b.seek(900);
 assert.deepEqual(b.take(0,2000),{position:900,expired:false});
 b.capture(900,2000);b.seek(1200);assert.deepEqual(b.take(0,63000),{position:1200,expired:true});
});
test('invalid positions cannot replace a valid pause bookmark',()=>{
 const b=createPauseBookmark();b.capture(25,1);b.capture(NaN,2);b.seek(-1);
 assert.deepEqual(b.take(0,60001),{position:25,expired:true});
});

// While paused, an encoded stream is held on the server (it ended one after two minutes without
// a request, so resuming re-buffered from scratch). Resume reuses the buffer when the hold is current.
import {createStreamHold,resumePlan,HOLD_EVERY_MS,HOLD_FRESH_MS} from './pause-resume.js';
const flush=()=>new Promise(r=>setImmediate(r));
function holdHarness(){
 const h={t:0,answer:true,asked:[],timers:[]};
 h.hold=createStreamHold({ask:async id=>{h.asked.push(id);if(h.answer instanceof Error)throw h.answer;return h.answer;},
  now:()=>h.t,schedule:(fn,ms)=>{h.timers.push({fn,ms});return h.timers.length;},cancel:n=>{h.timers[n-1].cancelled=true;}});
 return h;
}
test('a hold asks at once and every 45 s, and counts only while the latest answer is recent and yes',async()=>{
 const h=holdHarness(); h.hold.start('p1'); await flush();
 assert.deepEqual(h.asked,['p1']); assert.equal(h.timers[0].ms,HOLD_EVERY_MS); assert.equal(h.hold.held(),true);
 h.t=HOLD_FRESH_MS-1; assert.equal(h.hold.held(),true);
 h.t=HOLD_FRESH_MS; assert.equal(h.hold.held(),false,'an old answer no longer counts');
 h.answer=new Error('offline'); await h.timers[0].fn(); assert.equal(h.hold.held(),false,'a missed answer is not a yes');
 h.answer=true; await h.timers[0].fn(); assert.equal(h.hold.held(),true);
 h.answer=false; await h.timers[0].fn(); assert.equal(h.hold.held(),false);
 assert.equal(h.timers[0].cancelled,true,'the server said no: stop asking');
});
test('stopping forgets the answer and ignores one still on its way',async()=>{
 const h=holdHarness(); let release; h.answer=new Promise(r=>{release=r;});
 const slow=createStreamHold({ask:()=>h.answer,now:()=>h.t,schedule:()=>1,cancel:()=>{}});
 slow.start('p1'); slow.stop(); release(true); await flush();
 assert.equal(slow.held(),false);
 h.answer=true; h.hold.start('p2'); await flush(); assert.equal(h.hold.held(),true);
 h.hold.stop(); assert.equal(h.hold.held(),false); assert.equal(h.timers[0].cancelled,true);
});
test('resume keeps the buffer after a short pause, for a direct file, or while held; otherwise reopens',()=>{
 assert.equal(resumePlan({expired:false}),'buffer');
 assert.equal(resumePlan({expired:true,direct:true}),'buffer');
 assert.equal(resumePlan({expired:true,held:true}),'buffer');
 assert.equal(resumePlan({expired:true}),'reopen');
 assert.equal(resumePlan({expired:false,failed:true}),'reopen','a failed stream always reopens');
 assert.equal(resumePlan({expired:true,direct:true,failed:true}),'reopen');
});
