const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const text=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
function fixture() {
  const routes=new Map(),calls=[],admin=()=>{},library=()=>{};
  const review={snapshot:async options=>({ok:true,total:1,entries:[{id:'a'.repeat(32),name:'Movie.avi'}],...options})};
  const queue={status:'idle',start:async()=>{calls.push('start');return {ok:true};},resume:async()=>({ok:true}),snapshot:()=>({status:queue.status}),retryReview:async id=>{calls.push(['retry',id]);return {ok:true};}};
  const repair={busy:false,ready:async()=>{},snapshot:async()=>({status:'ready',reviewId:'a'.repeat(32),candidate:{verified:true},entries:[{reviewId:'a'.repeat(32),sourceName:'Movie.avi',status:'ready',previewReady:true}]}),
    start:async id=>{calls.push(['repair',id]);return {ok:true};},stop:async()=>({ok:true}),apply:async(id,install)=>{calls.push(['apply',id]);return {ok:true};},preview:async()=>({filePath:'/library/.conversion-repairs/id/candidate.mp4'})};
  const installer={busy:false,recover:async()=>{},install:async()=>({ok:true})};
  const modules={'./lib/conversion-review':()=>review,'./lib/conversion-queue':()=>queue,'./lib/conversion-repair-install':()=>installer,'./lib/conversion-repair':()=>repair};
  const c={require:name=>modules[name],path,fs,DATA_DIR:'/private',saveJSONStrict:async()=>{},loadJSON:()=>null,hashId:()=>'',conversionWorker:{},
    conversionConfig:{get:()=>({})},eligibleContainerFiles:()=>[],transcodeSessions:{},lastPlaybackAt:0,conversionStorage:{snapshot:async()=>({})},
    config:{folders:[]},console,mediaIdentity:{},isAudioFile:()=>false,scanLibrary:()=>[],markDirty(){},scheduleSaveMediaInfo(){},invalidateLibrary(){},
    requireAdminSession:admin,ensureLibrary:library,
    app:Object.fromEntries(['get','post'].map(method=>[method,(route,...handlers)=>routes.set(method+route,handlers)]))};
  for(const name of ['probeCache','pixFmtCache','audioProbeCache','audioTracksCache','subProbeCache','heightCache','levelCache'])c[name]={};
  vm.createContext(c);vm.runInContext(text.slice(text.indexOf('const conversionReview ='),text.indexOf('// Cleanup — delete retained originals')),c);
  async function request(method,route,{body={},query={},params={}}={}) {
    const res={code:200,status(code){this.code=code;return this;},json(value){this.body=value;return this;},set(value){this.headers=value;return this;},sendFile(file,opts){this.file=file;this.opts=opts;},end(){}};
    await routes.get(method+route).at(-1)({body,query,params},res);return res;
  }
  return {review,queue,repair,installer,calls,routes,admin,library,request};
}
test('review/repair endpoints are administrator-only and normalize candidate preview URLs',async()=>{
  const f=fixture();for(const [route,handlers]of f.routes)assert.equal(handlers[0],f.admin,route);
  const result=await f.request('get','/api/conversion/repair/status');
  assert.equal(result.body.candidate.previewUrl,'/api/conversion/repair/preview/'+'a'.repeat(32));
  assert.equal(result.body.entries[0].candidate.previewUrl,result.body.candidate.previewUrl);
  const rows=await f.request('get','/api/conversion/review',{query:{offset:'100'}});assert.equal(rows.body.offset,100);
});
test('simultaneous normal Start and repair cannot pass each other through async idle checks',async()=>{
  const f=fixture();let release,entered;const started=new Promise(r=>entered=r);
  f.queue.start=async()=>{entered();await new Promise(r=>release=r);return {ok:true};};
  const running=f.request('post','/api/conversion/start',{body:{all:true}});await started;
  const repair=await f.request('post','/api/conversion/repair/start',{body:{id:'a'.repeat(32)}});
  assert.equal(repair.code,409);assert.match(repair.body.error,/action is in progress/);assert.deepEqual(f.calls,[]);
  release();assert.equal((await running).code,200);
});
test('Start, Resume and explicit Retry are blocked during repair or failed startup recovery',async()=>{
  const f=fixture();f.repair.busy=true;
  for(const route of ['/api/conversion/start','/api/conversion/resume','/api/conversion/review/retry'])assert.equal((await f.request('post',route)).code,409);
  assert.deepEqual(f.calls,[]);f.repair.busy=false;f.repair.ready=async()=>{throw Error('Recovery needs attention');};
  assert.equal((await f.request('post','/api/conversion/start')).code,409);assert.deepEqual(f.calls,[]);
});
test('preview uses only validated private candidate paths and propagates changed-candidate rejection',async()=>{
  const f=fixture();const preview=await f.request('get','/api/conversion/repair/preview/:id',{params:{id:'a'.repeat(32)}});
  assert.equal(preview.file,'/library/.conversion-repairs/id/candidate.mp4');assert.equal(preview.headers['Cache-Control'],'private, no-store');
  f.repair.preview=async()=>{throw Error('Candidate changed');};
  const rejected=await f.request('get','/api/conversion/repair/preview/:id');assert.equal(rejected.code,409);assert.equal(rejected.file,undefined);
});
test('repair actions accept opaque review ID only, never a request supplied media path',async()=>{
  const f=fixture(),id='a'.repeat(32);
  await f.request('post','/api/conversion/repair/start',{body:{id,filePath:'/etc/passwd'}});
  await f.request('post','/api/conversion/review/retry',{body:{id,filePath:'/etc/passwd'}});
  await f.request('post','/api/conversion/repair/apply',{body:{id,filePath:'/etc/passwd'}});
  assert.deepEqual(f.calls,[['repair',id],['retry',id],['apply',id]]);
});
