const {test}=require('node:test');const assert=require('node:assert/strict');const {downloadReadiness}=require('./download-readiness');
test('100 percent does not authorize moving, checking, or errored downloads',()=>{
 for(const state of ['moving','checkingUP','checkingResumeData','error','unknown','downloading'])assert.equal(downloadReadiness([{name:'Pack',progress:1,state}]).entries[0].ready,false);
});
test('complete stopped and seeding downloads are ready and include actual folder names',()=>{
 const r=downloadReadiness([{name:'Display name',content_path:'/downloads/Actual folder',progress:1,state:'stoppedUP'}],123);
 assert.deepEqual(r,{updatedAt:123,entries:[{names:['Display name','Actual folder'],ready:true,state:'stoppedUP'}]});
 assert.equal(downloadReadiness([{progress:.9,state:'stalledUP'}]).entries[0].ready,false);
});
