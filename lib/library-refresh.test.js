const{test}=require('node:test');const assert=require('node:assert/strict');const create=require('./library-refresh');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
test('slow metadata does not block another inventory refresh or report premature completion',async()=>{
 const scans=[deferred(),deferred()],metadata=deferred();let n=0;
 const jobs=create({scan:()=>scans[n++].promise,enrich:()=>metadata.promise,now:()=>42});
 assert.equal(jobs.request().ok,true);assert.equal(jobs.status().lastCompletedAt,0);assert.equal(jobs.status().running,true);
 scans[0].resolve([]);await tick();assert.equal(jobs.status().running,false);assert.equal(jobs.status().enriching,true);assert.equal(jobs.status().lastCompletedAt,42);
 jobs.request();assert.equal(n,2);scans[1].resolve([]);metadata.resolve();await tick();assert.equal(jobs.status().enriching,false);
});
test('overlapping requests coalesce to one fresh inventory pass',async()=>{
 const scans=[deferred(),deferred()];let n=0;const jobs=create({scan:()=>scans[n++].promise,enrich:async()=>{}});
 jobs.request();for(let i=0;i<8;i++)assert.equal(jobs.request().queued,true);
 scans[0].resolve([]);await tick();assert.equal(n,2);assert.equal(jobs.status().running,true);scans[1].resolve([]);await tick();assert.equal(n,2);assert.equal(jobs.status().running,false);
});
test('failed scan is reported honestly and can be retried',async()=>{
 let fail=true;const jobs=create({scan:async()=>{if(fail)throw Error('disk offline');return[];},enrich:async()=>{}});
 jobs.request();await tick();assert.match(jobs.status().error,/failed/);assert.equal(jobs.status().lastCompletedAt,0);
 fail=false;jobs.request();await tick();assert.equal(jobs.status().error,'');assert.ok(jobs.status().lastCompletedAt>0);
});
