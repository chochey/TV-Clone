import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterShows,recentEpisodes,episodeDownload,downloadLabel} from './episode-report.js';
test('filters separate complete, missing and unchecked and search unmatched shows',()=>{
 const report={shows:[{show:'Complete',complete:true,seasons:[]},{show:'Missing',missingCount:2,seasons:[]},{show:'Unknown',needsCheck:true,seasons:[]}],unmatched:['Unidentified']};
 assert.equal(filterShows(report,'complete','').length,1);assert.equal(filterShows(report,'missing','').length,1);assert.equal(filterShows(report,'check','').length,2);assert.equal(filterShows(report,'all','identified')[0].show,'Unidentified');
});
test('new view includes ended shows but excludes future dates and older gaps',()=>{
 const show={ongoing:false,seasons:[{season:2,missing:[{episode:1,released:'2026-09-28'},{episode:2,released:'2026-10-02'},{episode:3,released:'2020-01-01'}]}]};
 assert.deepEqual(recentEpisodes(show,Date.parse('2026-09-29')).map(e=>e.episode),[1]);
});
test('download matching respects show, season, episode ranges and remake year',()=>{
 const t=[{name:'Show.2020.S01E02-E03.1080p',progress:.5},{name:'Other.S01E01',progress:1}];
 assert.equal(episodeDownload(t,'Show (2020)',1,2),t[0]);assert.equal(episodeDownload(t,'Show (2020)',1,3),t[0]);
 assert.equal(episodeDownload(t,'Show (2020)',1,4),undefined);assert.equal(episodeDownload(t,'Show (2021)',1,2),undefined);
 assert.equal(episodeDownload(t,'Show (2020)',2,2),undefined);
 assert.equal(downloadLabel(t[0]),'Downloading 50%');assert.equal(downloadLabel({progress:1,reviewReason:'Review'}),'Needs review');
 assert.ok(episodeDownload([{name:'Show.S01.1080p'}],'Show (2020)',1,3));
});
