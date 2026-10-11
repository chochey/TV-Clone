const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {createMediaIdentity,legacyId}=require('./media-identity');
const {saveJSONStrict}=require('./json-store');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-identity-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'registry.json');
 const make=save=>createMediaIdentity({file,save:save||saveJSONStrict});
 const media=(name,content='specific audiobook content')=>{const p=path.join(dir,name);fs.writeFileSync(p,content);return p;};
 const resolve=(r,p)=>r.resolve(p,fs.statSync(p));
 return{dir,file,make,media,resolve};
}
test('initial registry preserves existing public IDs and persists a rename across restart',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('before.m4b'),b=path.join(f.dir,'after.m4b');
 r.seed([{id:'abcdef0123456789',_filePath:a}]);r.begin([a]);
 assert.equal(await f.resolve(r,a),'abcdef0123456789');await r.persist();
 fs.renameSync(a,b);r.begin([b]);assert.equal(await f.resolve(r,b),'abcdef0123456789');await r.persist();
 assert.equal(f.make().idForPath(b),'abcdef0123456789');
});
test('cross-directory copy then removal is recognized but coexisting copies keep separate IDs',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('before.mp4'),b=path.join(f.dir,'copy.mp4');r.begin([a]);const id=await f.resolve(r,a);
 fs.copyFileSync(a,b);const st=fs.statSync(a);fs.utimesSync(b,st.atime,st.mtime);
 r.begin([a,b]);assert.notEqual(await f.resolve(r,b),id);
 const c=path.join(f.dir,'moved.mp4');fs.copyFileSync(a,c);fs.utimesSync(c,st.atime,st.mtime);fs.unlinkSync(a);
 r.begin([b,c]);assert.equal(await f.resolve(r,c),id);
});
test('ambiguous missing duplicates never combine their progress',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('a.mkv'),b=f.media('b.mkv');const st=fs.statSync(a);fs.utimesSync(b,st.atime,st.mtime);
 r.begin([a,b]);const first=await f.resolve(r,a),second=await f.resolve(r,b);
 const c=path.join(f.dir,'c.mkv');fs.copyFileSync(a,c);fs.utimesSync(c,st.atime,st.mtime);fs.unlinkSync(a);fs.unlinkSync(b);
 r.begin([c]);const id=await f.resolve(r,c);assert.notEqual(id,first);assert.notEqual(id,second);
});
test('a vacated path receives a distinct ID if the original moved elsewhere',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('a.mp4'),b=path.join(f.dir,'b.mp4');r.begin([a]);const original=await f.resolve(r,a);
 fs.renameSync(a,b);r.begin([b]);assert.equal(await f.resolve(r,b),original);
 f.media('a.mp4','entirely different file');r.begin([a,b]);assert.notEqual(await f.resolve(r,a),original);
});
test('verified conversion keeps the identity and supports durable rollback',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('a.mkv'),b=f.media('a.mp4','converted bytes');r.begin([a]);const id=await f.resolve(r,a);await r.persist();
 const undo=await r.relocate(a,b);assert.equal(r.idForPath(b),id);assert.equal(f.make().idForPath(b),id);
 await undo();assert.equal(r.idForPath(a),id);assert.equal(r.idForPath(b),legacyId(b));
});
test('registry failure prevents a conversion binding from reporting success',async t=>{
 const f=fixture(t),r=f.make(async()=>{throw new Error('disk full');}),a=f.media('a.mkv'),b=f.media('a.mp4','output');
 r.begin([a]);const id=await f.resolve(r,a);await assert.rejects(r.relocate(a,b),/disk full/);
 assert.equal(r.idForPath(a),id);assert.equal(r.idForPath(b),legacyId(b));
});
test('corrupt identity state is never silently replaced',t=>{
 const f=fixture(t);fs.writeFileSync(f.file,'{"version":1,"entries":{"/file":{"id":"bad"}}}');assert.throws(()=>f.make(),/Invalid/);
});

test('one missing original and two new identical destinations do not guess which copy owns progress',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('original.m4b'),b=path.join(f.dir,'copy-b.m4b'),c=path.join(f.dir,'copy-c.m4b');
 r.begin([a]);const old=await f.resolve(r,a),st=fs.statSync(a);
 for(const target of [b,c]){fs.copyFileSync(a,target);fs.utimesSync(target,st.atime,st.mtime);}fs.unlinkSync(a);
 r.begin([b,c]);const first=await f.resolve(r,b),second=await f.resolve(r,c);
 assert.notEqual(first,old);assert.notEqual(second,old);assert.notEqual(first,second);
});
test('stale cached catalog seeding cannot resurrect a relocated ID under the old pathname',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('old.mkv'),b=f.media('new.mp4','verified output'),id='abcd0123456789ef';
 r.seed([{_filePath:a,id}]);r.begin([a]);await f.resolve(r,a);await r.relocate(a,b);
 r.seed([{_filePath:a,id}]);assert.equal(r.isCurrent(a,id),false);assert.equal(r.isCurrent(b,id),true);
 await r.persist();const saved=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(saved.entries[a],undefined);assert.equal(saved.entries[b].id,id);
});
test('relocation revision and exact-binding checks cover in-flight commit and undo',async t=>{
 const f=fixture(t);let release,block=false;
 const r=f.make(async(file,data)=>{if(block)await new Promise(resolve=>release=resolve);await saveJSONStrict(file,data);});
 const a=f.media('a.mkv'),b=f.media('a.mp4','output');r.begin([a]);const id=await f.resolve(r,a);await r.persist();
 const initial=r.revision;block=true;const moving=r.relocate(a,b);
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(r.revision>initial);assert.equal(r.isCurrent(b,id),false);
 await assert.rejects(f.resolve(r,b),/relocation is in progress/);
 block=false;release();const undo=await moving;assert.equal(r.isCurrent(b,id),true);
 const committed=r.revision;await undo();assert.ok(r.revision>committed);assert.equal(r.isCurrent(a,id),true);
});
test('fingerprinting rejects symlinks and detects a same-size replacement even when mtime is preserved',async t=>{
 const f=fixture(t),r=f.make(),a=f.media('a.m4b'),link=path.join(f.dir,'link.m4b');
 fs.symlinkSync(a,link);r.begin([link]);await assert.rejects(f.resolve(r,link));
 fs.utimesSync(a,new Date('2026-01-01'),new Date('2026-01-01'));
 r.begin([a]);await f.resolve(r,a);await r.persist();const old=fs.statSync(a);
 const before=JSON.parse(fs.readFileSync(f.file,'utf8')).entries[a].fingerprint;
 const replacement=f.media('replacement.m4b','D'.repeat(old.size));fs.utimesSync(replacement,old.atime,old.mtime);
 fs.renameSync(replacement,a);r.begin([a]);await f.resolve(r,a);await r.persist();
 const saved=JSON.parse(fs.readFileSync(f.file,'utf8'));assert.equal(saved.entries[a].ino,fs.statSync(a).ino);
 assert.notEqual(saved.entries[a].fingerprint,before);
});
test('duplicate persistent ID bindings are rejected rather than combining unrelated profiles',t=>{
 const f=fixture(t),id='abcd0123456789ef';fs.writeFileSync(f.file,JSON.stringify({version:1,entries:{'/a':{id},'/b':{id}}}));
 assert.throws(()=>f.make(),/duplicate media identity/);
});
