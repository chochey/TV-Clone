import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { get } from 'svelte/store';
import { unpackCatalog } from './catalog-response.js';
import { library, catalog, recentlyAdded, genreClusters, seriesIndex, watchState, continueWatching, updateWatchState } from './stores.js';
import { seriesSummary, cardPlayback } from './series-playback.js';
const { packCatalog } = createRequire(import.meta.url)('../../../../lib/catalog-response.js');
const episode = (n, extra = {}) => ({ id: `e${n}`, type: 'show', showName: 'Test', title: `Episode ${n}`, epInfo: {season:1,episode:n}, addedAt:n, filename:`episode${n}.mkv`, watched:false, progress:{percent:0}, ...extra });

test('compact catalog preserves playback/search identity and deduplicates shared plots', () => {
  const items = Array.from({length:40}, (_,i)=>episode(i, {plot:'Shared plot '.repeat(100),genre:'Drama',fileSize:123,hasSubs:true,hasAudioTracks:false,streamMode:'transcode',codec:'hevc'}));
  const packed = packCatalog(items), decoded = unpackCatalog(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(decoded, items); assert.equal(packed.shared.length, 1);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(items).length / 3);
  assert.deepEqual(unpackCatalog(items), items); assert.deepEqual(unpackCatalog({items}), items);
});

test('progress updates do not rebuild catalog indexes or shelf lists and preserve live state', () => {
  library.set([episode(1),episode(2),{id:'film',type:'movie',watched:false}]);
  let structures = 0;
  const stops = [catalog,recentlyAdded,genreClusters,seriesIndex].map(s=>s.subscribe(()=>structures++));
  const initial = structures;
  updateWatchState('e1', {progress:{currentTime:100,duration:1000,percent:10,updatedAt:1}});
  updateWatchState('e1', {progress:{currentTime:200,duration:1000,percent:20,updatedAt:2}});
  assert.equal(structures, initial);
  assert.equal(get(continueWatching)[0].progress.currentTime, 200);
  assert.equal(get(library)[0].progress.currentTime, 200);
  assert.equal(cardPlayback(episode(1),get(seriesIndex),get(watchState)).progress.currentTime,200);
  stops.forEach(s=>s()); library.set([]);
});

test('series badges aggregate all episodes, deduplicate encodes, and change for new episodes', () => {
  const items=[episode(1,{watched:true}),episode(2),episode(1,{id:'copy',watched:false})];
  library.set(items);
  const summary=()=>seriesSummary(items[0],get(seriesIndex),get(watchState));
  assert.deepEqual(summary(),{total:2,watched:1,allWatched:false});
  updateWatchState('e2',{watched:true}); assert.equal(summary().allWatched,true);
  library.update(items=>[...items,episode(3)]); assert.deepEqual(summary(),{total:3,watched:2,allWatched:false});
  library.set([]);
});
