const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const os=require('os');const path=require('path');
const {saveJSON,saveJSONStrict}=require('./json-store');
test('strict persistence waits behind queued writes and its completed value is readable',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'json-store-'));t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const file=path.join(dir,'profile.json');saveJSON(file,{old:true});await saveJSONStrict(file,{migrated:true});
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{migrated:true});
});
test('strict persistence propagates asynchronous filesystem errors',async()=>{
 await assert.rejects(saveJSONStrict('/dev/null/profile.json',{migrated:true}),/ENOTDIR/);
});
