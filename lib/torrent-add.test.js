const { test } = require('node:test');
const assert = require('node:assert/strict');
const { magnetHashes, splitTorrentAdds, duplicateAddResult } = require('./torrent-add');
const v1 = '000102030405060708090a0b0c0d0e0f10111213';
const base32 = 'AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQT';
const v2 = 'abcdef0123456789'.repeat(4);
const magnet = hash => `magnet:?xt=urn:btih:${hash}`;

test('hex, base32, percent encoding and case normalize to the exact v1 identity', () => {
  for (const url of [magnet(v1.toUpperCase()), magnet(base32), magnet(base32.toLowerCase()), `MAGNET:?xt=${encodeURIComponent('urn:btih:' + base32)}`]) {
    assert.deepEqual(magnetHashes(url), ['v1:' + v1]);
    assert.deepEqual(splitTorrentAdds([url], [{hash:v1}]), {newUrls:[],existingIndexes:[0]});
  }
});

test('v2 and hybrid magnets match full explicit and magnet identities', () => {
  const pure = `magnet:?xt=urn:btmh:1220${v2.toUpperCase()}`;
  const hybrid = `${magnet(v1)}&xt=urn:btmh:1220${v2}`;
  assert.deepEqual(magnetHashes(hybrid), ['v1:' + v1, 'v2:' + v2]);
  for (const row of [{hash:v2}, {hash:v2.slice(0,40),infohash_v2:v2}, {hash:v1,magnet_uri:hybrid}]) {
    assert.deepEqual(splitTorrentAdds([pure,hybrid],[row]), {newUrls:[],existingIndexes:[0]});
  }
  assert.deepEqual(splitTorrentAdds([magnet(v1)],[{infohash_v1:v1.toUpperCase()}]).existingIndexes,[0]);
});

test('v2 truncated routing hashes cannot masquerade as exact v1 or v2 matches', () => {
  const row = {hash:v2.slice(0,40),magnet_uri:`magnet:?xt=urn:btmh:1220${v2}`};
  const urls = [magnet(row.hash), `magnet:?xt=urn:btmh:1220${v2.slice(0,40)}${'0'.repeat(24)}`];
  assert.deepEqual(splitTorrentAdds(urls,[row]), {newUrls:urls,existingIndexes:[]});
});

test('names, query hints, malformed magnets and HTTP links never imply duplicate identity', () => {
  const urls = ['https://example.test/a.torrent?hash='+v1, 'magnet:?dn='+v1,
    'magnet:?xt=urn:btih:'+v1+'0', 'magnet:?xt=urn:btih:'+base32.slice(0,-1)+'0',
    'magnet:?xt=urn:btmh:1221'+v2, magnet('f'.repeat(40))+'&dn=Existing+movie'];
  assert.deepEqual(splitTorrentAdds(urls,[{hash:v1,name:'Existing movie'}]), {newUrls:urls,existingIndexes:[]});
});

test('mixed batches retain every new URL and deduplicate repeated existing identities', () => {
  const newer = magnet('b'.repeat(40)), http = 'https://example.test/download/42';
  assert.deepEqual(splitTorrentAdds([magnet(v1),newer,magnet(base32),http],[{hash:v1}]),
    {newUrls:[newer,http],existingIndexes:[0]});
});

test('invalid upstream snapshots are errors, never an empty authoritative list', () => {
  for (const rows of [null,{},'[]',[null],[[]]]) assert.throws(()=>splitTorrentAdds([magnet(v1)],rows),/invalid torrent list/);
});

test('only verified decorator status can report an existing torrent as imported', () => {
  assert.equal(duplicateAddResult([{name:'Movie',progress:1,importStatus:{label:'Imported files available'}}]).imported,false);
  const row = {name:'Movie',hash:v1,save_path:'/private',magnet_uri:magnet(v1),importStatus:{readyToHide:true}};
  const reply = duplicateAddResult([row]);
  assert.equal(reply.imported,true); assert.equal(reply.name,'Movie'); assert.match(reply.message,/library/);
  assert.equal(reply.hash,undefined); assert.equal(reply.save_path,undefined); assert.equal(reply.magnet_uri,undefined);
  assert.equal(duplicateAddResult([row],1).imported,false);
  assert.equal(duplicateAddResult([row,{}]).imported,false);
});
