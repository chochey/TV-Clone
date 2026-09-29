const {test}=require('node:test');const assert=require('node:assert/strict');const create=require('./system-stats');
const df='Filesystem 1B-blocks Used Avail Use% Mounted on\n/dev/sda 100 60 40 60% /\n/dev/sdb 100 96 4 96% /media/blue/New Volume\n';
test('concurrent stats requests share async disk work and preserve a previous snapshot on failure',async()=>{
 let clock=10000,calls=0,fail=false,release;const gate=new Promise(r=>release=r);
 const stats=create({now:()=>clock,io:{readFile:async()=>{throw Error('absent');}},run:async cmd=>{if(cmd==='lspci')return {ok:true,stdout:'00:01 VGA controller: Intel UHD'};calls++;await gate;return {ok:!fail,stdout:fail?'':df};}});
 const a=stats.snapshot(),b=stats.snapshot();await Promise.resolve();assert.equal(calls,1);release();const [first,second]=await Promise.all([a,b]);assert.equal(first.disks[1].mount,'/media/blue/New Volume');assert.deepEqual(second.disks,first.disks);
 await stats.snapshot();assert.equal(calls,1);clock+=10001;fail=true;const last=await stats.snapshot();assert.equal(calls,2);assert.equal(last.storageStale,true);assert.deepEqual(last.disks,first.disks);
});
