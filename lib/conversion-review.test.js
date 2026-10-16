const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const create=require('./conversion-review');
const {fileFingerprint,describe,MAX_BYTES,sameFingerprint}=create;

// Regression: /mnt/media is a mergerfs union, which synthesises inode numbers
// and renumbers them on every mount. Holds are persisted, so comparing dev/ino
// marked all 46 live review rows "changed" after a reboot and made every one of
// them permanently unretryable, though no file had been touched.
test('a hold follows the media, not its inode number or mount',()=>{
  const held={dev:39,ino:987186,size:966423194,mtimeMs:1791358599104.47,ctimeMs:1791358748062.52};
  for (const drift of [{ino:21654},{dev:41},{ctimeMs:1799999999999},{dev:41,ino:3,ctimeMs:1}]) {
    assert.equal(sameFingerprint(held,{...held,...drift}),true,JSON.stringify(drift));
  }
  // A real edit still releases nothing: size or mtime moving is a content change.
  assert.equal(sameFingerprint(held,{...held,size:held.size+1}),false);
  assert.equal(sameFingerprint(held,{...held,mtimeMs:held.mtimeMs+1000}),false);
  // A malformed fingerprint is still rejected outright.
  assert.equal(sameFingerprint(held,{size:held.size,mtimeMs:held.mtimeMs}),false);
  assert.ok(!sameFingerprint(held,null));
});
const {saveJSONStrict}=require('./json-store');
async function fixture(t) {
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'conversion-review-'));
  t.after(()=>fs.promises.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'reviews.json'),source=path.join(dir,'source.avi');
  await fs.promises.writeFile(source,'original source bytes');
  const entry={filePath:source,mediaId:'permanent-source',fingerprint:await fileFingerprint(source)};
  const make=over=>create({file,save:saveJSONStrict,...over});
  return {dir,file,source,entry,make};
}
test('failure summaries distinguish materially incomplete sources from isolated parser and decoder diagnostics',()=>{
  assert.equal(describe('File ended prematurely; declared 3487s, measured 923s').category,'incomplete');
  assert.equal(describe('source container duration 2593s differs from measured packet extent 606s').category,'incomplete');
  assert.equal(describe('source packet parser reported invalid EBML; declared container 2593.140000s; measured video track 0: packets 14344, span 606.313s, audio track 1: packets 18692, span 606.080s').category,'incomplete');
  assert.equal(describe('source packet parser reported 43 bytes ([mp3float] Header missing)').category,'parser');
  assert.match(describe('source packet parser reported 43 bytes ([mp3float] Header missing)').summary,/extent needs checking/);
  assert.equal(describe('conversion reported media errors ([ac3] incomplete frame)').category,'decode');
  assert.equal(describe('conversion reported media errors ([mpeg4] ac-tex damaged)').category,'decode');
  assert.equal(describe('source timestamp/packet inconsistency, backwards DTS 4').category,'timestamps');
  assert.equal(describe('MP4 destination already exists; review the duplicate first').category,'duplicate');
  assert.equal(describe('HDR / Dolby Vision needs a separate preset').category,'unsupported');
  assert.equal(describe('Converted copied video track lost packets').category,'verification');
});
test('a durable hold keeps its original timestamp, details and identity across restart',async t=>{
  const f=await fixture(t),r=f.make();await r.seed(null);
  await r.record(f.entry,{ok:false,reason:'Needs review: incomplete frame; original retained'},{at:1000});
  assert.equal(r.isBlocked(f.entry),true);
  const first=(await r.snapshot()).entries[0];
  await r.record(f.entry,{ok:false,reason:'Needs review: incomplete frame again'},{at:2000});
  const reboot=f.make();await reboot.ready({expectExisting:true});
  const saved=await reboot.get(first.id);
  assert.equal(saved.firstFailedAt,1000);assert.equal(saved.lastFailedAt,2000);assert.equal(saved.attempts,2);
  assert.equal(saved.id,first.id);assert.equal(saved.mediaId,'permanent-source');
  saved.fingerprint.size=999;assert.equal(reboot.isBlocked(f.entry),true,'API data must not mutate the hold');
  assert.equal((await reboot.snapshot()).total,1);
});
test('changing a source automatically removes its suppression without releasing the old evidence',async t=>{
  const f=await fixture(t),r=f.make();await r.seed(null);await r.record(f.entry,{ok:false,reason:'Header missing'});
  await fs.promises.writeFile(f.source,'a newly supplied replacement with different media bytes');
  const replacement={...f.entry,fingerprint:await fileFingerprint(f.source)};
  assert.equal(r.isBlocked(replacement),false);assert.equal((await r.snapshot()).total,1);
  assert.equal((await r.record(f.entry,{ok:false,reason:'old in-flight failure'})).recorded,false);
  await r.record(replacement,{ok:false,reason:'replacement decode failed'},{at:3000});
  assert.equal(r.isBlocked(replacement),true);assert.equal(r.isBlocked(f.entry),false);
  assert.equal((await r.snapshot()).entries[0].attempts,1);
});
test('a verified changed source retires only its captured prior review token after strict persistence',async t=>{
  const f=await fixture(t),r=f.make();await r.seed(null);await r.record(f.entry,{ok:false,reason:'old decode failure'});
  const priorReviewId=r.priorIdForPath(f.source);await fs.promises.writeFile(f.source,'new complete source');
  const replacement={...f.entry,fingerprint:await fileFingerprint(f.source)};
  assert.deepEqual(await r.complete(replacement),{removed:false},'a changed fingerprint alone must not release a hold');
  assert.deepEqual(await r.complete(replacement,{priorReviewId}),{removed:true});
  assert.equal((await r.snapshot()).total,0);assert.equal((await f.make().snapshot()).total,0);
});
test('a captured stale-review token cannot remove a newer review for another replacement identity',async t=>{
  const f=await fixture(t),r=f.make();await r.seed(null);await r.record(f.entry,{ok:false,reason:'first damaged source'});
  const priorReviewId=r.priorIdForPath(f.source);
  await fs.promises.writeFile(f.source,'first replacement');const queued={...f.entry,fingerprint:await fileFingerprint(f.source)};
  await fs.promises.writeFile(f.source,'later replacement has another identity');const later={...f.entry,fingerprint:await fileFingerprint(f.source)};
  await r.record(later,{ok:false,reason:'newer replacement failed'});
  assert.deepEqual(await r.complete(queued,{priorReviewId}),{removed:false});
  assert.equal(r.isBlocked(later),true);assert.equal((await r.snapshot()).total,1);
});
test('upgrade seeding requires the saved run fingerprint and preserves real failure timestamps',async t=>{
  const f=await fixture(t),changed=path.join(f.dir,'changed.avi'),success=path.join(f.dir,'successful.avi');
  await fs.promises.writeFile(changed,'old');await fs.promises.writeFile(success,'valid');
  const changedEntry={filePath:changed,fingerprint:await fileFingerprint(changed)},successEntry={filePath:success,fingerprint:await fileFingerprint(success)};
  await fs.promises.writeFile(changed,'new source content');
  const old={run:{id:'run',queue:[f.entry,changedEntry,successEntry],results:[
    {filePath:f.source,runId:'run',ok:false,reason:'first failure',at:1000},
    {filePath:f.source,runId:'run',ok:false,reason:'later failure',at:2000},
    {filePath:changed,runId:'run',ok:false,reason:'old source failed',at:3000},
    {filePath:success,runId:'run',ok:false,reason:'older attempt',at:1000},
    {filePath:success,runId:'run',ok:true,at:4000},
  ]},history:[{filePath:f.source,runId:'run',ok:false,reason:'first failure',at:1000}]};
  const r=f.make();assert.deepEqual(await r.seed(old),{seeded:1});
  const row=(await r.snapshot()).entries[0];assert.equal(row.firstFailedAt,1000);assert.equal(row.lastFailedAt,2000);assert.equal(row.attempts,2);
  assert.equal(r.isBlocked(f.entry),true);assert.equal(r.isBlocked(changedEntry),false);
  assert.deepEqual(await r.seed(old),{seeded:0});assert.equal((await r.snapshot()).entries[0].attempts,2);
});
test('prior runs without matching saved fingerprint proof never become upgrade holds',async t=>{
  const f=await fixture(t),r=f.make();
  await r.seed({run:{id:'new-run',queue:[f.entry],results:[]},history:[{filePath:f.source,runId:'old-run',ok:false,at:1000,reason:'old failure'}]});
  assert.equal((await r.snapshot()).total,0);
});
test('a hold is visible only after strict persistence completes, and failed writes never release it',async t=>{
  const f=await fixture(t);let block=false,release,fail=false;
  const r=f.make({save:async(file,data)=>{if(block)await new Promise(resolve=>release=resolve);if(fail)throw Error('disk full');await saveJSONStrict(file,data);}});
  await r.seed(null);block=true;
  const recording=r.record(f.entry,{ok:false,reason:'decode error'});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.isBlocked(f.entry),false);release();await recording;block=false;
  fail=true;await assert.rejects(r.complete(f.entry),/disk full/);assert.equal(r.isBlocked(f.entry),true);
  const reboot=f.make();await reboot.ready({expectExisting:true});assert.equal(reboot.isBlocked(f.entry),true);
});
test('missing or corrupt established review state fails closed instead of clearing failed sources',async t=>{
  const f=await fixture(t),r=f.make();await r.seed(null);await r.record(f.entry,{ok:false,reason:'decode error'});
  const saved=await fs.promises.readFile(f.file);
  await fs.promises.unlink(f.file);
  await assert.rejects(r.ready(),{code:'EREVIEWSTATE'});await assert.rejects(r.snapshot(),{code:'EREVIEWSTATE'});
  await assert.rejects(f.make().seed({reviewInitialized:true}),{code:'EREVIEWSTATE'});
  assert.equal(fs.existsSync(f.file),false);
  await fs.promises.writeFile(f.file,'{corrupt');await assert.rejects(f.make().seed(null),{code:'EREVIEWSTATE'});
  await fs.promises.writeFile(f.file,saved);assert.equal((await r.snapshot()).total,1);
});
test('review persistence refuses symbolic-link state files and never holds symbolic-link sources',async t=>{
  const f=await fixture(t),real=path.join(f.dir,'real.json');
  await fs.promises.writeFile(real,JSON.stringify({version:1,seeded:true,entries:[]}));await fs.promises.symlink(real,f.file);
  await assert.rejects(f.make().snapshot(),{code:'EREVIEWSTATE'});await fs.promises.unlink(f.file);
  const r=f.make();await r.seed(null);const alias=path.join(f.dir,'alias.avi');await fs.promises.symlink(f.source,alias);
  assert.equal((await r.record({...f.entry,filePath:alias},{ok:false,reason:'decode error'})).recorded,false);
});
test('bounded state rejects oversized files and invalid records, and caps diagnostic/page size',async t=>{
  const f=await fixture(t);const h=await fs.promises.open(f.file,'w');await h.truncate(MAX_BYTES+1);await h.close();
  await assert.rejects(f.make().snapshot(),{code:'EREVIEWSTATE'});await fs.promises.unlink(f.file);
  const r=f.make();await r.seed(null);await r.record(f.entry,{ok:false,reason:'x'.repeat(10000)});
  const row=(await r.snapshot({limit:10000})).entries[0];assert.equal(row.details.length,4096);
  assert.equal((await r.snapshot({limit:10000})).limit,200);
  const data=JSON.parse(await fs.promises.readFile(f.file));data.entries.push(data.entries[0]);
  await fs.promises.writeFile(f.file,JSON.stringify(data));await assert.rejects(f.make().ready(),{code:'EREVIEWSTATE'});
});
