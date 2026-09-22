import test from 'node:test';
import assert from 'node:assert/strict';
import {startupFragmentCount,startHlsFromPosition} from './playback-startup.js';
test('long first chunks do not wait for another live playlist refresh',()=>{
 assert.equal(startupFragmentCount('#EXTM3U\n#EXTINF:12.416667,\nseg_0000.m4s'),1);
 assert.equal(startupFragmentCount('#EXTM3U\n#EXTINF:5.005,\nseg_0000.m4s'),2);
});
test('startup and resume explicitly load the on-demand position, never the live edge',()=>{
 const positions=[];const hls={startLoad:(position=-1)=>positions.push(position)};
 startHlsFromPosition(hls);startHlsFromPosition(hls,24.5);
 assert.deepEqual(positions,[0,24.5]);
});
