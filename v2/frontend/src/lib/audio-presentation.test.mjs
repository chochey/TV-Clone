import test from 'node:test';
import assert from 'node:assert/strict';
import { readableAudioTitle, audioPresentation, audioRemaining, audioChapters, activeAudioChapter, audioChapterLabel } from './audio-presentation.js';

test('filename cleanup preserves natural and embedded titles', () => {
  assert.equal(readableAudioTitle('CarlsDoomsdayScenarioDungeonCrawlerCarlBook2_ep7.m4b'), 'Carls Doomsday Scenario Dungeon Crawler Carl Book 2');
  assert.equal(readableAudioTitle('CarlsDoomsdayScenarioDungeonCrawlerCarlBook2 ep7'), 'Carls Doomsday Scenario Dungeon Crawler Carl Book 2');
  assert.equal(readableAudioTitle('The Long Way to a Small Angry Planet_ep7.mp3'), 'The Long Way to a Small Angry Planet');
  assert.equal(readableAudioTitle('McCarthy’s 1984: A Story.m4b'), 'McCarthy’s 1984: A Story');
  assert.equal(readableAudioTitle('McCarthy’s_1984:_A_Story_ep7.m4b'), 'McCarthy’s 1984: A Story');
  assert.equal(readableAudioTitle('DUNE.m4b'), 'DUNE');
  assert.equal(audioPresentation({ filename:'SomethingElse.m4b', audioMetadata:{ title:'McCarthy’s eBook: Part II' } }).title, 'McCarthy’s eBook: Part II');
  assert.equal(readableAudioTitle(''), 'Audiobook');
});
test('metadata supplies artist and duration without repeating the title as album', () => {
  assert.deepEqual(audioPresentation({ title:'RawName', artist:'Fallback', audioMetadata:{ title:' Book title ', artist:' Author ', album:'Book title', duration:600, coverUrl:'/audio-artwork/book' } }),
    { title:'Book title', artist:'Author', album:'', duration:600, coverUrl:'/audio-artwork/book' });
  assert.equal(audioPresentation({ audioMetadata:{ duration:Infinity } }).duration, 0);
});
test('remaining time is clear near completion and for long audiobooks', () => {
  assert.equal(audioRemaining(3661), '1 hr 2 min left'); assert.equal(audioRemaining(3600), '1 hr left');
  assert.equal(audioRemaining(59.2), '1 min left'); assert.equal(audioRemaining(12.1), '13 sec left');
  assert.equal(audioRemaining(0), '0 sec left'); assert.equal(audioRemaining(NaN), ''); assert.equal(audioRemaining(-5), '');
});
test('chapter boundaries discard invalid entries and follow seeks', () => {
  const chapters = audioChapters([{ title:'Second',start:30,end:90 },{ title:'Opening',start:0,end:40 },{ title:'Duplicate',start:30 },{ start:45,end:44 },{ start:-1 },{ start:NaN },{ start:60 }], 60);
  assert.deepEqual(chapters, [{ title:'Opening',start:0,end:30 },{ title:'Second',start:30,end:45 },{ title:'Chapter 3',start:45,end:60 }]);
  assert.equal(activeAudioChapter(chapters, 29.9), 0); assert.equal(activeAudioChapter(chapters, 30), 1); assert.equal(activeAudioChapter(chapters, 59), 2);
  assert.equal(activeAudioChapter(chapters, 12), 0); assert.equal(activeAudioChapter([], 12), -1); assert.equal(audioChapterLabel(chapters[1]), 'Second · 0:30');
  assert.equal(audioChapters(null).length, 0);
});
test('the catalog cover and author show before (and instead of) the per-book lookup', () => {
  assert.deepEqual(audioPresentation({ title: 'Book title', artist: 'Author', coverUrl: '/audio-artwork/b?v=1-2' }),
    { title: 'Book title', artist: 'Author', album: '', duration: 0, coverUrl: '/audio-artwork/b?v=1-2' });
  assert.equal(audioPresentation({ title: 'Book title', coverUrl: '/audio-artwork/b?v=1-2', audioMetadata: { coverUrl: '/audio-artwork/b' } }).coverUrl,
    '/audio-artwork/b?v=1-2');
});
