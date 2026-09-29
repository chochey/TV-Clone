// Run: node --test lib/episode-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseEpisodeNumbers, isOngoingYear, buildHoldings, diffSeason } = require('./episode-index.js');

test('parseEpisodeNumbers: single, range, and double-episode names', () => {
  assert.deepEqual(parseEpisodeNumbers('Show - S01E05 - Title.mkv'), [5]);
  assert.deepEqual(parseEpisodeNumbers('Grimm (2011) - S05E21-E22 - Beginning of the End.mkv').sort((a, b) => a - b), [21, 22]);
  assert.deepEqual(parseEpisodeNumbers('Show S01E01E02.mkv').sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(parseEpisodeNumbers('Show S02E10-11.mkv').sort((a, b) => a - b), [10, 11]);
  assert.deepEqual(parseEpisodeNumbers('Movie 1080p x265.mkv'), []);
});

test('parseEpisodeNumbers: absurd ranges are not expanded', () => {
  // "S01E01-E99" style junk should not fabricate 99 episodes
  const eps = parseEpisodeNumbers('Show S01E01-E99.mkv');
  assert.ok(eps.length <= 2);
});

test('isOngoingYear: en-dash and hyphen endings', () => {
  assert.equal(isOngoingYear('2022–'), true);
  assert.equal(isOngoingYear('2025-'), true);
  assert.equal(isOngoingYear('2011–2017'), false);
  assert.equal(isOngoingYear('2005'), false);
  assert.equal(isOngoingYear(null), false);
});

test('buildHoldings: groups by show/season, folder season wins, ranges expand', () => {
  const h = buildHoldings([
    { type: 'show', showName: 'X (2020)', epInfo: { season: 1, episode: 1 }, relDir: 'X (2020)/Season 01', filename: 'X - S01E01.mkv' },
    { type: 'show', showName: 'X (2020)', epInfo: { season: 1, episode: 2 }, relDir: 'X (2020)/Season 02', filename: 'X - S01E02.mkv' }, // dir says S2
    { type: 'show', showName: 'X (2020)', epInfo: { season: 3, episode: 4 }, relDir: null, filename: 'X - S03E04-E05.mkv' },
    { type: 'movie', title: 'Nope', filename: 'nope.mkv' },
  ]);
  const x = h.get('X (2020)');
  assert.deepEqual([...x.seasons.get(1)], [1]);
  assert.deepEqual([...x.seasons.get(2)], [2]);
  assert.deepEqual([...x.seasons.get(3)].sort(), [4, 5]);
});

test('diffSeason: aired-and-not-held is missing; unaired is future', () => {
  const now = Date.parse('2026-07-12');
  const eps = [
    { episode: 1, title: 'A', released: '2026-01-01' },
    { episode: 2, title: 'B', released: '2026-01-08' },
    { episode: 3, title: 'C', released: '2026-12-25' }, // future
    { episode: 4, title: 'D', released: null },          // date unknown
  ];
  const { missing, future } = diffSeason(eps, new Set([1]), now);
  assert.deepEqual(missing.map((m) => m.episode), [2]);
  assert.equal(future, 2);
});

test('diffSeason: OMDb duplicate episode rows count once', () => {
  // Friends S10 really does list two E18 rows on OMDb.
  const now = Date.parse('2026-07-12');
  const eps = [
    { episode: 18, title: 'The Last One: Part 1', released: '2004-05-06' },
    { episode: 18, title: 'The Last One: Part 2', released: '2004-05-06' },
  ];
  const { missing } = diffSeason(eps, new Set(), now);
  assert.equal(missing.length, 1);
});

test('diffSeason: fully held season has no gaps', () => {
  const now = Date.parse('2026-07-12');
  const eps = [
    { episode: 1, released: '2020-01-01' },
    { episode: 2, released: '2020-01-08' },
  ];
  const { missing, future } = diffSeason(eps, new Set([1, 2]), now);
  assert.equal(missing.length, 0);
  assert.equal(future, 0);
});
const createIndex = require('./episode-index.js');
const NOW=Date.parse('2026-09-29T12:00:00Z');
const episode={episode:1,title:'Premiere',released:'2026-09-28'};
function fixture(cache={},fetchImpl=async()=>{throw Error('Offline')}) {
 const idx=createIndex({DATA_DIR:'/unused',loadJSON:()=>cache,saveJSON:()=>{},apiKey:'fixture',baseUrl:'https://unused.invalid',fetchImpl});
 return (opts={})=>idx.buildReport({holdings:new Map([['Show',{seasons:new Map([[1,new Set([1])]])}]]),getShowMeta:()=>({imdbID:'tt1',omdbYear:'2025–'}),now:NOW,...opts});
}
test('unknown and failed seasons never count as complete',async()=>{
 for(const cache of [{},{'tt1|1':{fetchedAt:NOW,error:'Limit reached',episodes:[],totalSeasons:1}}]) {
 const r=await fixture(cache)();assert.equal(r.shows[0].complete,false);assert.equal(r.shows[0].needsCheck,true);assert.equal(r.staleSlots,1);
 }
});
test('entire missing seasons retain individual episodes for new listings and tracker alerts',async()=>{
 const r=await fixture({'tt1|1':{fetchedAt:NOW,totalSeasons:2,episodes:[episode]},'tt1|2':{fetchedAt:NOW,totalSeasons:2,episodes:[episode]}})({onlyOngoing:true});
 assert.equal(r.shows[0].seasons[0].season,2);assert.equal(r.shows[0].seasons[0].missing[0].title,'Premiere');assert.equal(r.shows[0].missingCount,1);
});
test('new seasons discovered during refresh are checked immediately within budget',async()=>{
 let calls=0;const progress=[];const r=await fixture({},async()=>{calls++;return {ok:true,json:async()=>({totalSeasons:'2',Episodes:[{Episode:'1',Released:'2026-09-28',Title:'Premiere'}]})};})({budget:10,onProgress:p=>progress.push(p)});
 assert.equal(calls,2);assert.equal(r.shows[0].seasons.length,2);assert.equal(r.shows[0].missingCount,1);assert.equal(progress.at(-1).showsDone,1);
});
test('discovered seasons remain unchecked when the request budget runs out',async()=>{
 const r=await fixture({},async()=>({ok:true,json:async()=>({totalSeasons:'3',Episodes:[{Episode:'1',Released:'2026-09-28'}]})}))({budget:1});
 assert.equal(r.budgetUsed,1);assert.equal(r.shows[0].seasons.length,3);assert.equal(r.staleSlots,2);assert.equal(r.shows[0].complete,false);
});
test('failed refresh preserves previous gaps and retries after an hour instead of a month',async()=>{
 let calls=0;const run=fixture({'tt1|1':{fetchedAt:NOW-40*86400000,totalSeasons:1,episodes:[episode,{...episode,episode:2}]}},async()=>{calls++;throw Error('Offline');});
 let r=await run({budget:10});assert.equal(r.shows[0].missingCount,1);assert.equal(r.shows[0].complete,false);assert.match(r.shows[0].seasons[0].error,/Offline/);
 await run({budget:10});assert.equal(calls,1);
 await run({budget:10,now:NOW+3600001});assert.equal(calls,2);
});
test('complete means all known aired episodes checked, unknown dates do not imply complete',async()=>{
 let r=await fixture({'tt1|1':{fetchedAt:NOW,totalSeasons:1,episodes:[episode]}})();assert.equal(r.shows[0].complete,true);
 r=await fixture({'tt1|1':{fetchedAt:NOW,totalSeasons:1,episodes:[episode,{episode:2,released:null}]}})();assert.equal(r.shows[0].complete,false);
});
