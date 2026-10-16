const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const createRetry = require('./organizer-retry');
const key = source => crypto.createHash('sha256').update(source).digest('hex').slice(0, 24);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-retry-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const sourceDir = path.join(dir, 'Share'), spoolDir = path.join(dir, 'retries');
  fs.mkdirSync(sourceDir); fs.mkdirSync(path.join(sourceDir, 'Iron Man [1080p]'));
  const queue = [{ id:'0123456789ab', source:'Iron Man [1080p]', title:'Iron Man', type:'movie', resolved:false }];
  const retry = createRetry({ sourceDir, spoolDir, getReviewQueue:() => queue, shared:false });
  return { dir, sourceDir, spoolDir, queue, retry };
}
function packet(f) { return JSON.parse(fs.readFileSync(path.join(f.spoolDir, key(f.queue[0].source) + '.json'))); }

test('only an exact unresolved review source can create a durable private retry request', async t => {
  const f = fixture(t), result = await f.retry.enqueue(f.queue[0].id), saved = packet(f);
  assert.equal(result.ok, true); assert.equal(result.queued, true); assert.match(result.requestId, /^[a-f0-9]{32}$/);
  assert.equal(saved.source, 'Iron Man [1080p]'); assert.equal(saved.title, 'Iron Man'); assert.equal(saved.fingerprint.kind, 'directory');
  assert.equal(fs.statSync(f.spoolDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.spoolDir, key(saved.source) + '.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes(f.sourceDir), false);
  assert.equal(fs.existsSync(path.join(f.sourceDir, saved.source)), true);
});

test('unknown, resolved and removed review entries cannot schedule work', async t => {
  const f = fixture(t);
  await assert.rejects(f.retry.enqueue('bad-input'), error => error.status === 400);
  await assert.rejects(f.retry.enqueue('abcdef123456'), error => error.status === 404);
  f.queue[0].resolved = true; await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 404);
  f.queue[0].resolved = false; fs.rmdirSync(path.join(f.sourceDir, f.queue[0].source));
  await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 404);
});

test('release paths and parked/admin folders are rejected, without prefix matching another release', async t => {
  const f = fixture(t);
  for (const source of ['../Share','a/b','a\\b','.hidden','_review','incomplete','a\nb']) {
    f.queue[0].source = source;
    await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 404);
  }
  f.queue[0].source = 'Iron Man';
  await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 404);
});

test('symlink release and symlink queue directories are refused', async t => {
  const f = fixture(t); fs.rmdirSync(path.join(f.sourceDir, f.queue[0].source));
  fs.symlinkSync(f.dir, path.join(f.sourceDir, f.queue[0].source));
  await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 409);
  fs.unlinkSync(path.join(f.sourceDir, f.queue[0].source)); fs.mkdirSync(path.join(f.sourceDir, f.queue[0].source));
  fs.symlinkSync(f.dir, f.spoolDir);
  await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 503);
});

test('concurrent clients and multiple episode review reasons coalesce into one release retry', async t => {
  const f = fixture(t); f.queue.push({ ...f.queue[0], id:'abcdef123456', reason:'Second unresolved episode' });
  const results = await Promise.all([f.retry.enqueue(f.queue[0].id), f.retry.enqueue(f.queue[1].id), f.retry.enqueue(f.queue[0].id)]);
  assert.equal(new Set(results.map(result => result.requestId)).size, 1);
  assert.equal(fs.readdirSync(f.spoolDir).filter(name => name.endsWith('.json')).length, 1);
});

test('a claimed retry remains coalesced while the organizer is importing', async t => {
  const f = fixture(t), first = await f.retry.enqueue(f.queue[0].id), base = key(f.queue[0].source);
  fs.renameSync(path.join(f.spoolDir, base + '.json'), path.join(f.spoolDir, base + '.claimed.json'));
  const second = await f.retry.enqueue(f.queue[0].id);
  assert.equal(second.requestId, first.requestId); assert.equal((await f.retry.snapshot())[0].status, 'claimed');
});

test('replaced same-name release cannot silently reuse an old request', async t => {
  const f = fixture(t); await f.retry.enqueue(f.queue[0].id);
  fs.renameSync(path.join(f.sourceDir, f.queue[0].source), path.join(f.sourceDir, 'Old release'));
  fs.mkdirSync(path.join(f.sourceDir, f.queue[0].source));
  await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 409);
});

test('full queues reject additional requests without deleting outstanding work', async t => {
  const f = fixture(t); fs.mkdirSync(f.spoolDir);
  for (let index = 0; index < 64; index++) fs.writeFileSync(path.join(f.spoolDir, index.toString(16).padStart(24,'0') + '.json'), '{}');
  await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 503);
  assert.equal(fs.readdirSync(f.spoolDir).length, 64);
});

test('receipts expose status only, completion wins a briefly retained claim, and a new retry has a new id', async t => {
  const f = fixture(t), first = await f.retry.enqueue(f.queue[0].id), saved = packet(f), base = key(saved.source);
  fs.renameSync(path.join(f.spoolDir, base + '.json'), path.join(f.spoolDir, base + '.claimed.json'));
  fs.writeFileSync(path.join(f.spoolDir, base + '.done.json'), JSON.stringify({ ...saved, status:'attempted', completedAt:Date.now() }));
  const statuses = await f.retry.snapshot(); assert.equal(statuses.length, 1); assert.equal(statuses[0].status, 'attempted');
  assert.equal('fingerprint' in statuses[0], false); assert.equal('title' in statuses[0], false);
  fs.unlinkSync(path.join(f.spoolDir, base + '.claimed.json'));
  const second = await f.retry.enqueue(f.queue[0].id); assert.notEqual(second.requestId, first.requestId);
});

test('malformed or linked spool records never expose raw errors or their target contents', async t => {
  const f = fixture(t); fs.mkdirSync(f.spoolDir);
  fs.writeFileSync(path.join(f.spoolDir, key(f.queue[0].source) + '.json'), 'private-text-not-for-output');
  await assert.rejects(f.retry.enqueue(f.queue[0].id), error => error.status === 503 && !error.message.includes('private-text'));
  assert.deepEqual(await f.retry.snapshot(), []);
});

function sharedFixture(t, options={}) {
  const f = fixture(t), gid = process.getegid() || 42424;
  fs.mkdirSync(f.spoolDir);
  if (fs.statSync(f.spoolDir).gid !== gid) fs.chownSync(f.spoolDir,process.geteuid(),gid);
  fs.chmodSync(f.spoolDir,0o2770);
  const create = overrides => createRetry({ sourceDir:f.sourceDir, spoolDir:f.spoolDir, getReviewQueue:()=>f.queue,
    shared:true, gid, identity:()=>({uid:process.geteuid(),groups:[gid]}), ...options, ...overrides });
  return {...f,gid,create,retry:create()};
}

test('explicit shared mode preserves setgid and publishes group-writable packets despite a restrictive umask', async t => {
  const f = sharedFixture(t), previous = process.umask(0o077);
  let first;
  try { first = await f.retry.enqueue(f.queue[0].id); }
  finally { process.umask(previous); }
  const filename = path.join(f.spoolDir,key(f.queue[0].source)+'.json');
  assert.equal(fs.statSync(f.spoolDir).mode & 0o7777,0o2770);
  assert.equal(fs.statSync(filename).mode & 0o7777,0o660);
  assert.equal(fs.statSync(filename).gid,f.gid);
  fs.renameSync(filename,filename.replace('.json','.claimed.json'));
  assert.equal((await f.create().enqueue(f.queue[0].id)).requestId,first.requestId);
  assert.equal((await f.retry.snapshot())[0].status,'claimed');
});

test('shared mode requires an existing private setgid directory and explicit matching group membership', async t => {
  const f = sharedFixture(t);
  for (const options of [{gid:undefined},{gid:'bad'},{gid:0},{gid:0xffffffff},{gid:f.gid+1},
      {identity:()=>({uid:process.geteuid(),groups:[]})}]) {
    await assert.rejects(f.create(options).enqueue(f.queue[0].id),error=>error.status===503);
  }
  for (const mode of [0o770,0o2775,0o2777,0o2700]) {
    fs.chmodSync(f.spoolDir,mode);
    await assert.rejects(f.retry.enqueue(f.queue[0].id),error=>error.status===503);
    assert.equal(fs.statSync(f.spoolDir).mode & 0o7777,mode);
  }
  fs.rmdirSync(f.spoolDir);
  await assert.rejects(f.retry.enqueue(f.queue[0].id));
  assert.equal(fs.existsSync(f.spoolDir),false,'shared directories are never silently provisioned');
});

test('shared readers refuse incorrectly grouped or public packets without exposing contents', async t => {
  const f = sharedFixture(t); await f.retry.enqueue(f.queue[0].id);
  const filename=path.join(f.spoolDir,key(f.queue[0].source)+'.json');
  fs.chmodSync(filename,0o664);
  await assert.rejects(f.retry.enqueue(f.queue[0].id),error=>error.status===503);
  assert.deepEqual(await f.retry.snapshot(),[]);
  fs.chmodSync(filename,0o660);
  assert.equal((await f.retry.snapshot())[0].status,'queued');
});

test('a FIFO masquerading as a shared packet is rejected without blocking the queue', {timeout:2000}, async t => {
  const f=sharedFixture(t),filename=path.join(f.spoolDir,key(f.queue[0].source)+'.json');
  execFileSync('mkfifo',[filename]); fs.chmodSync(filename,0o660);
  await assert.rejects(f.retry.enqueue(f.queue[0].id),error=>error.status===503);
  assert.deepEqual(await f.retry.snapshot(),[]);
});

test('shared mode refuses an untrusted owner and symlink directory', async t => {
  const f = sharedFixture(t);
  if (process.geteuid()===0) fs.chownSync(f.spoolDir,12345,f.gid);
  await assert.rejects(f.create({identity:()=>({uid:67890,groups:[f.gid]})}).enqueue(f.queue[0].id),error=>error.status===503);
  fs.rmdirSync(f.spoolDir); fs.symlinkSync(f.dir,f.spoolDir);
  await assert.rejects(f.retry.enqueue(f.queue[0].id),error=>error.status===503);
});

test('two simulated service identities accept the same administrator-owned shared queue', async t => {
  if (process.geteuid()!==0) { t.skip('root-owned fixture requires elevated synthetic test run'); return; }
  const f=sharedFixture(t);
  const first=await f.create({identity:()=>({uid:12345,groups:[f.gid]})}).enqueue(f.queue[0].id);
  const second=await f.create({identity:()=>({uid:67890,groups:[f.gid]})}).enqueue(f.queue[0].id);
  assert.equal(second.requestId,first.requestId);
  assert.equal((await f.create({identity:()=>({uid:67890,groups:[f.gid]})}).snapshot())[0].status,'queued');
});

test('two actual temporary process UIDs exchange a Node request and Python receipt through only the dedicated group', async t => {
  if (process.geteuid()!==0) { t.skip('temporary process UID changes require elevated synthetic test run'); return; }
  const f=sharedFixture(t);
  fs.chmodSync(f.dir,0o755);
  const modulePath=path.join(f.dir,'retry.js'),helperPath=path.join(f.dir,'organizer_retry_spool.py');
  fs.copyFileSync(require.resolve('./organizer-retry'),modulePath);
  fs.copyFileSync(path.join(__dirname,'../media-organizer/organizer_retry_spool.py'),helperPath);
  const script=String.raw`
import json, os, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1]); gid=int(sys.argv[2])
env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'ORGANIZER_RETRY_SHARED':'1','ORGANIZER_RETRY_GID':str(gid)}
def run(uid,args):
    def private_identity():
        os.setgroups([gid]); os.setgid(gid); os.setuid(uid)
    result=subprocess.run(args,capture_output=True,text=True,env=env,preexec_fn=private_identity)
    if result.returncode: raise AssertionError(result.stderr)
    return result.stdout
node="const retry=require(process.argv[1])({sourceDir:process.argv[2],spoolDir:process.argv[3],getReviewQueue:()=>[{id:'0123456789ab',source:'Iron Man [1080p]',title:'Iron Man',type:'movie'}]});retry.enqueue('0123456789ab').then(value=>console.log(JSON.stringify(value))).catch(()=>process.exit(1));"
queued=json.loads(run(12345,['node','-e',node,str(root/'retry.js'),str(root/'Share'),str(root/'retries')]))
python="import sys;sys.path.insert(0,sys.argv[1]);from organizer_retry_spool import RetrySpool;s=RetrySpool(sys.argv[2],sys.argv[3]);assert s.poll()[0]['source']=='Iron Man [1080p]';assert s.wants('Iron Man [1080p]');s.complete('Iron Man [1080p]');s.close()"
run(67890,['python3','-c',python,str(root),str(root/'Share'),str(root/'retries')])
node="const retry=require(process.argv[1])({sourceDir:process.argv[2],spoolDir:process.argv[3],getReviewQueue:()=>[]});retry.snapshot().then(value=>console.log(JSON.stringify(value))).catch(()=>process.exit(1));"
done=json.loads(run(12345,['node','-e',node,str(root/'retry.js'),str(root/'Share'),str(root/'retries')]))
assert done[0]['requestId']==queued['requestId'] and done[0]['status']=='attempted'
assert (root/'Share'/'Iron Man [1080p]').is_dir()
assert (root/'retries').stat().st_mode & 0o7777 == 0o2770
for file in (root/'retries').iterdir():
    assert file.stat().st_gid == gid and file.stat().st_mode & 0o7777 == 0o660
`;
  execFileSync('python3',['-c',script,f.dir,String(f.gid)],{timeout:10000,stdio:'pipe'});
});
