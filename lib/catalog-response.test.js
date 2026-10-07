const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompactCache, packCatalog } = require('./catalog-response');
test('compact metadata cache shares work without sharing a viewers progress or watched state', () => {
  const response = createCompactCache(), items = [{id:'film'}]; let builds = 0;
  const build = () => { builds++; return [{id:'film',title:'Film',progress:{percent:99},watched:true}]; };
  const a = response(items,'v1',build,{progress:{film:{percent:25}},watched:{film:true}});
  const b = response(items,'v1',build,{progress:{},watched:{}});
  const progress = a.fields.indexOf('progress')+1, watched = a.fields.indexOf('watched')+1;
  assert.equal(builds,1); assert.equal(a.rows[0][progress].percent,25); assert.equal(a.rows[0][watched],true);
  assert.equal(b.rows[0][progress].percent,0); assert.equal(b.rows[0][watched],false);
  assert.equal(a.rows[0][progress].percent,25,'second viewer must not mutate the first response');
  response(items,'v2',build,{progress:{},watched:{}}); assert.equal(builds,2);
  response([...items],'v2',build,{progress:{},watched:{}}); assert.equal(builds,3);
});

test('compact catalogs retain playback kind and opaque section identity without internal paths', () => {
  const playbackIssue = 'Protected Audible files cannot be played here.';
  const packed = packCatalog([{ id: 'audio', type: 'custom-podcasts', mediaKind: 'audio',
    sectionId: 'library-opaque', folder: 'Podcasts', playbackIssue, streamMode: 'unsupported',
    _filePath: '/private/book.aax', folderPath: '/private' }]);
  const metadata = packed.shared[packed.rows[0][0]];
  assert.equal(metadata.type, 'custom-podcasts');
  assert.equal(metadata.mediaKind, 'audio');
  assert.equal(metadata.sectionId, 'library-opaque');
  assert.equal(packed.rows[0][packed.fields.indexOf('playbackIssue') + 1], playbackIssue);
  assert.ok(!JSON.stringify(packed).includes('/private'));
});
