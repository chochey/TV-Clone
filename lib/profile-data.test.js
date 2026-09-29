const {test}=require('node:test');const assert=require('node:assert/strict');const create=require('./profile-data');
test('strict profile writes wait for persistence and restore cached data on rejection',async()=>{
 let rejectWrite;const pending=new Promise((_,reject)=>{rejectWrite=reject;});
 const profiles=create({DATA_DIR:'/profiles',loadJSON:()=>({progress:{old:{currentTime:12}}}),saveJSON(){},saveJSONStrict:()=>pending});
 const original=profiles.loadProfileData('one'), migrated={progress:{new:{currentTime:12}}};
 const saving=profiles.saveProfileDataStrict('one',migrated);
 assert.equal(profiles.loadProfileData('one'),migrated);rejectWrite(Error('disk full'));
 await assert.rejects(saving,/disk full/);assert.equal(profiles.loadProfileData('one'),original);
});
