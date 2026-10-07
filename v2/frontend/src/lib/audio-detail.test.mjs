import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAudioDetail, audioDetailArtwork, audioDetailDuration } from './audio-detail.js';
import { audioPresentation } from './audio-presentation.js';

test('detail uses authored audio tags even when the full response has a raw filename title', () => {
  const item = { id:'book', mediaKind:'audio', title:'This Inevitable Ruin', audioMetadata:{ title:'This Inevitable Ruin', artist:'Matt Dinniman', duration:92700, coverUrl:'/audio-artwork/book' }, progress:{ percent:10 }, watched:false };
  const full = { id:'book', title:'ThisInevitableRuinDungeonCrawlerCarlBook7_ep7', progress:{ percent:25 }, watched:true,
    audioMetadata:{ title:'This Inevitable Ruin', artist:'Matt Dinniman', duration:92700, coverUrl:'/audio-artwork/book', chapters:[{ title:'Opening', start:0, end:70 }] } };
  const before = structuredClone(item);
  const detail = mergeAudioDetail(item, full);
  assert.equal(detail.title, 'This Inevitable Ruin');
  assert.equal(audioPresentation(detail).artist, 'Matt Dinniman');
  assert.equal(detail.audioMetadata.duration, 92700);
  assert.equal(detail.audioMetadata.chapters.length, 1);
  assert.equal(detail.progress.percent, 25);
  assert.equal(detail.watched, true);
  assert.deepEqual(item, before);
});

test('a temporary partial metadata response preserves known audio tags and artwork', () => {
  const item = { mediaKind:'audio', title:'Known Book', audioMetadata:{ title:'Known Book', artist:'An Author', album:'An Edition', duration:7200, coverUrl:'/audio-artwork/book', chapters:[{ start:0 }] } };
  for (const audioMetadata of [undefined, null, {}, { title:'', artist:null, album:' ', duration:0, coverUrl:null }]) {
    const detail = mergeAudioDetail(item, { title:'RawName_ep7', audioMetadata, progress:{ percent:30 } });
    assert.equal(detail.title, 'Known Book');
    assert.deepEqual(audioPresentation(detail), { title:'Known Book', artist:'An Author', album:'An Edition', duration:7200, coverUrl:'/audio-artwork/book' });
    assert.equal(detail.audioMetadata.chapters.length, 1);
    assert.equal(detail.progress.percent, 30);
  }
});

test('fresh full audio metadata replaces earlier values without retaining old chapters', () => {
  const item = { type:'audio', audioMetadata:{ title:'Old title', artist:'Old author', duration:600, coverUrl:'/old', chapters:[{ start:0 }] } };
  const detail = mergeAudioDetail(item, { audioMetadata:{ title:'Updated title', artist:'New author', duration:900, coverUrl:'/new', chapters:[] } });
  assert.equal(detail.title, 'Updated title');
  assert.equal(detail.audioMetadata.artist, 'New author');
  assert.equal(detail.audioMetadata.duration, 900);
  assert.equal(detail.audioMetadata.coverUrl, '/new');
  assert.deepEqual(detail.audioMetadata.chapters, []);
});

test('audio without tags gets a readable filename fallback including direct detail loads', () => {
  assert.equal(mergeAudioDetail(null, { mediaKind:'audio', title:'TheWayofKingsBook1_ep7' }).title, 'The Wayof Kings Book 1');
  assert.equal(mergeAudioDetail({ mediaKind:'audio', filename:'DUNE.m4b' }, null).title, 'DUNE');
});

test('film and series detail merging retains the existing full-response behavior', () => {
  for (const mediaKind of ['movie', 'show']) {
    const item = { id:'video', mediaKind, title:'Catalog title', posterUrl:'/poster', progress:{ percent:10 } };
    const full = { title:'Full title', runtime:'45 min', progress:{ percent:20 }, audioMetadata:null };
    assert.deepEqual(mergeAudioDetail(item, full), { ...item, ...full });
  }
});

test('artwork tries a disk poster then embedded cover, with no movie metadata fallback', () => {
  assert.deepEqual(audioDetailArtwork({ posterUrl:'/poster/book', omdbPosterUrl:'/wrong-film', audioMetadata:{ coverUrl:'/audio-artwork/book' } }), ['/poster/book', '/audio-artwork/book']);
  assert.deepEqual(audioDetailArtwork({ posterUrl:'/audio-artwork/book', audioMetadata:{ coverUrl:'/audio-artwork/book' } }), ['/audio-artwork/book']);
  assert.deepEqual(audioDetailArtwork({ audioMetadata:{ coverUrl:'/audio-artwork/book' } }), ['/audio-artwork/book']);
  assert.deepEqual(audioDetailArtwork({}), []);
});

test('audio duration is readable for short recordings and long books', () => {
  assert.equal(audioDetailDuration(25), 'Under 1 min');
  assert.equal(audioDetailDuration(600), '10 min');
  assert.equal(audioDetailDuration(7200), '2 hr');
  assert.equal(audioDetailDuration(7261), '2 hr 2 min');
  for (const value of [undefined, 0, -1, NaN, Infinity]) assert.equal(audioDetailDuration(value), '');
});
