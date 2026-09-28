const test = require('node:test');
const assert = require('node:assert/strict');
const { embeddedTracks } = require('./subtitle-tracks');
test('image tracks are exposed and English forced is distinguished from SDH', () => {
 const tracks = embeddedTracks('episode', [
 {index:2, codec:'hdmv_pgs_subtitle', lang:'eng', title:'SDH'},
 {index:3, codec:'hdmv_pgs_subtitle', lang:'eng', title:'Forced'},
 {index:4, codec:'subrip', extractable:true, lang:'eng', forced:true},
 {index:5, codec:'unknown', lang:'eng'},
 ]);
 assert.equal(tracks.length,3); assert.equal(tracks[0].forced,false);
 assert.equal(tracks[1].forced,true); assert.equal(tracks[1].bitmap,true);
 assert.equal(tracks[2].forced,true); assert.equal(tracks[2].bitmap,false);
 assert.match(tracks[1].label,/English.*foreign dialogue/);
});
