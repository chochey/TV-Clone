const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const create = require('./qbt');
async function fixture(t, handler, timeoutMs = 1000) {
 const server = http.createServer(handler);
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
 return create({QBT_BASE:`http://127.0.0.1:${server.address().port}`,QBT_USERNAME:'test',QBT_PASSWORD:'test',timeoutMs});
}
test('commands reject upstream failures instead of reporting success', async t => {
 const client = await fixture(t,(_,res)=>{res.writeHead(500);res.end('failed');});
 await assert.rejects(client.qbt('POST','/api/v2/torrents/stop','hashes=abc'),/HTTP 500/);
});
test('hanging downloader requests have a deadline', async t => {
 const client = await fixture(t,()=>{},30);
 await assert.rejects(client.qbt('GET','/slow'),/timed out/);
});
test('invalid JSON does not masquerade as a download list', () => {
 const client = create({QBT_BASE:'http://localhost'});
 assert.throws(()=>client.qbtJson({data:'Forbidden'}),/invalid response/);
});
test('expired authentication retries once with the new cookie', async t => {
 let commands=0;
 const client = await fixture(t,(req,res)=>{
  if(req.url.endsWith('/login')) {res.setHeader('set-cookie','SID=renewed');res.end('Ok.');}
  else if(++commands===1){res.writeHead(403);res.end();}
  else {assert.match(req.headers.cookie,/renewed/);res.end('[]');}
 });
 assert.deepEqual(client.qbtJson(await client.qbt('GET','/list')),[]);assert.equal(commands,2);
});
