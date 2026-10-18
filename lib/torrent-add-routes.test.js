const { test } = require('node:test');
const assert = require('node:assert/strict');
const hash = 'a'.repeat(40), newHash = 'b'.repeat(40);
const magnet = value => `magnet:?xt=urn:btih:${value}`;
function fixture({torrents=[],post={status:200,data:'Ok.'},getError,decorateError,decorate=rows=>rows}={}) {
  const calls=[],decorated=[],permission=()=>{},configured=()=>{};
  let handlers;
  const routes=new Map();
  require('./routes/downloads')({get(){},post:(route,...middleware)=>routes.set(route,middleware)},{
    requirePermission:name=>{assert.equal(name,'canDownload');return permission;},requireQbt:configured,
    qbtJson:reply=>reply,
    qbt:async(method,url,body)=>{calls.push({method,url,body});if(method==='GET'){if(getError)throw getError;return torrents;}if(post instanceof Error)throw post;return post;},
    downloadsWithStatus:async rows=>{decorated.push(rows);if(decorateError)throw decorateError;return decorate(rows);},
  });
  handlers=routes.get('/api/qbt/torrents/add');
  async function request(urls,savepath) {
    const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handlers.at(-1)({body:{urls,savepath}},res);return res;
  }
  return {calls,decorated,request,handlers,permission,configured};
}

test('duplicate add is a permission-gated success with no downloader mutation',async()=>{
  const torrents=[{hash,name:'Existing movie',state:'stoppedDL',progress:0}];
  const f=fixture({torrents});
  assert.equal(f.handlers[0],f.permission);assert.equal(f.handlers[1],f.configured);
  const reply=await f.request(magnet(hash));
  assert.equal(reply.code,200);assert.equal(reply.body.ok,true);assert.equal(reply.body.alreadyExists,true);
  assert.equal(reply.body.imported,false);assert.equal(reply.body.name,'Existing movie');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});

test('full authoritative snapshot is decorated before reporting a verified imported duplicate',async()=>{
  const torrents=[{hash,name:'Imported movie'},{hash:newHash,name:'Unrelated download'}];
  const f=fixture({torrents,decorate:rows=>rows.map(row=>({...row,importStatus:{readyToHide:row.hash===hash}}))});
  const reply=await f.request(magnet(hash));
  assert.equal(f.decorated[0],torrents);assert.equal(f.decorated[0].length,2);
  assert.equal(reply.body.imported,true);assert.match(reply.body.message,/library/);
  assert.equal(f.calls.length,1);
});

test('mixed batches add only new URLs and preserve savepath',async()=>{
  const f=fixture({torrents:[{hash,name:'Existing'}]});
  const http='https://example.test/file.torrent';
  const reply=await f.request(`${magnet(hash)}\r\n ${magnet(newHash)} \n${http}`,'/downloads');
  assert.equal(reply.code,200);assert.equal(reply.body.alreadyExists,true);assert.equal(reply.body.imported,false);
  assert.equal(reply.body.addedCount,2);assert.equal(reply.body.existingCount,1);
  const body=new URLSearchParams(f.calls[1].body);
  assert.equal(body.get('urls'),`${magnet(newHash)}\n${http}`);assert.equal(body.get('savepath'),'/downloads');
});

test('a fresh magnet is added normally after a valid empty snapshot',async()=>{
  const f=fixture();const reply=await f.request(magnet(newHash));
  assert.equal(reply.code,200);assert.equal(reply.body.ok,true);assert.equal(reply.body.alreadyExists,undefined);
  assert.equal(f.calls[1].url,'/api/v2/torrents/add');assert.equal(f.decorated.length,0);
});

test('HTTP URLs are forwarded without speculative name matching or remote resolution',async()=>{
  const f=fixture({torrents:[{hash,name:'Movie'}]});const url='https://example.test/Movie.torrent';
  const reply=await f.request(url);assert.equal(reply.code,200);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].method,'POST');assert.equal(new URLSearchParams(f.calls[0].body).get('urls'),url);
});

test('invalid links are rejected before reading or changing the downloader',async()=>{
  for(const url of ['',magnet('invalid'),'https://example.test/movie.html']) {
    const f=fixture();assert.equal((await f.request(url)).code,400);assert.equal(f.calls.length,0);
  }
});

test('upstream list and decoration failures cannot become duplicate success or start new downloads',async()=>{
  for(const options of [{getError:Error('Downloader authentication failed.')},{torrents:{}},{torrents:[null]},
    {torrents:[{hash}],decorateError:Error('Status unavailable')}]) {
    const f=fixture(options);const reply=await f.request(`${magnet(hash)}\n${magnet(newHash)}`);
    assert.equal(reply.code,500);assert.equal(reply.body.ok,undefined);assert.ok(reply.body.error);
    assert.equal(f.calls.length,1);
  }
});

test('genuine add failures in mixed batches remain errors even when one torrent exists',async()=>{
  for(const post of [{status:200,data:'Fails.'},{status:500,data:'Failure'},Error('Downloader timed out.')]) {
    const f=fixture({torrents:[{hash}],post});const reply=await f.request(`${magnet(hash)}\n${magnet(newHash)}`);
    assert.ok(reply.code>=500);assert.notEqual(reply.body.ok,true);assert.equal(reply.body.alreadyExists,undefined);
  }
});
