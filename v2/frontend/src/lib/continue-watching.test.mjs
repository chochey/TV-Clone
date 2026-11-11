import test from 'node:test';
import assert from 'node:assert/strict';
import { continueWatchingList } from './continue-watching.js';
import { seriesKey } from './series-playback.js';

const ep = (season, episode, extra = {}) => ({
  id: `s${season}e${episode}`, type: 'show', showName: 'The Strain (2014)', epInfo: { season, episode },
  filename: `The Strain - S0${season}E0${episode}.mkv`, ...extra,
});
const film = (id, extra = {}) => ({ id, type: 'movie', title: id, filename: `${id}.mp4`, ...extra });
const done = at => ({ watched: true, progress: { percent: 97, currentTime: 2700, duration: 2780, updatedAt: at } });
const partway = (percent, at) => ({ watched: false, progress: { percent, currentTime: percent * 60, duration: 6000, updatedAt: at } });

function list(items, state, hidden = {}, now = 1000) {
  const byId = new Map(items.map(i => [i.id, i]));
  const index = new Map();
  for (const i of items) { const k = seriesKey(i); if (k) index.set(k, [...(index.get(k) || []), i]); }
  return continueWatchingList({ state, byId, hidden, seriesIndex: index, now });
}

test('finishing an episode offers the next one, ahead of a film paused earlier', () => {
  const items = [ep(3, 6), ep(3, 7), ep(3, 8), ep(3, 9), film('jumanji')];
  const out = list(items, { s3e6: done(100), s3e7: done(200), jumanji: partway(60, 50) });
  assert.deepEqual(out.map(i => i.id), ['s3e8', 'jumanji']);
  assert.equal(out[0].upNext, true);
  assert.equal(out[0].progress.updatedAt, 200, 'sorted by when the last episode was finished');
  assert.equal(out[0].progress.percent, 0);
  assert.deepEqual(out[0].previousEpisode, { id: 's3e7', epInfo: { season: 3, episode: 7 } }, 'the episode just finished, for the card');
  assert.equal(out[1].upNext, undefined);
});

test('an episode stopped partway is still resumed, and an older one from the same show is not listed', () => {
  const items = [ep(1, 3), ep(1, 7), ep(1, 8)];
  const out = list(items, { s1e3: partway(40, 10), s1e7: partway(20, 300) });
  assert.deepEqual(out.map(i => i.id), ['s1e7']);
  assert.equal(out[0].upNext, undefined);
});

test('the newest thing done in a show decides: a finished episode beats an older paused one', () => {
  const items = [ep(1, 3), ep(1, 6), ep(1, 7)];
  const out = list(items, { s1e3: partway(40, 10), s1e6: done(300) });
  assert.deepEqual(out.map(i => i.id), ['s1e7']);
});

test('a next episode that was started keeps its place to resume from', () => {
  const items = [ep(1, 1), ep(1, 2)];
  const out = list(items, { s1e2: partway(30, 10), s1e1: done(300) });
  assert.deepEqual(out.map(i => [i.id, i.progress.percent, i.progress.currentTime]), [['s1e2', 30, 1800]]);
});

test('the next episode crosses into the next season', () => {
  const items = [ep(1, 13), ep(2, 1), ep(2, 2)];
  assert.deepEqual(list(items, { s1e13: done(5) }).map(i => i.id), ['s2e1']);
});

test('nothing is offered after the last episode, and extras without a number never count as next', () => {
  const extra = { id: 'derry-extra', type: 'show', showName: 'The Strain (2014)', epInfo: null, filename: 'A Story.mkv' };
  const items = [ep(3, 9), extra];
  assert.deepEqual(list(items, { s3e9: done(5) }), []);
});

test('episodes already watched are skipped to the first one not seen; none left, or hidden, offers nothing', () => {
  const items = [ep(1, 1), ep(1, 2), ep(1, 3)];
  assert.deepEqual(list(items, { s1e1: done(5), s1e2: { watched: true, progress: { percent: 0, updatedAt: 5 } } }).map(i => i.id), ['s1e3']);
  assert.deepEqual(list(items, { s1e1: done(5), s1e2: done(1), s1e3: { watched: true } }), []);
  assert.deepEqual(list(items, { s1e1: done(5) }, { s1e2: true }), []);
});

test('films only appear while partway, hidden titles stay hidden, and removed files are skipped', () => {
  const items = [film('a'), film('b'), film('c')];
  const out = list(items, { a: done(9), b: partway(50, 5), c: partway(10, 7), gone: partway(30, 99) }, { c: true });
  assert.deepEqual(out.map(i => i.id), ['b']);
});

test('an episode finished more than three months ago offers nothing (Tonight could never clear it)', () => {
  const items = [ep(1, 1), ep(1, 2)];
  const day = 86400000, now = 200 * day;
  assert.deepEqual(list(items, { s1e1: done(now - 91 * day) }, {}, now), []);
  assert.deepEqual(list(items, { s1e1: done(now - 89 * day) }, {}, now).map(i => i.id), ['s1e2']);
});

// Gamer (9 min left), Doom (15) and Jumanji: The Next Level (16) sat in "Also in progress" for weeks: all
// stopped in the credits, below the 92% that marks a title watched (the user's Tonight page, 2026-11-10).
const stopped = (minutesIn, minutesLong, at) => ({ watched: false,
  progress: { percent: Math.round(minutesIn / minutesLong * 100), currentTime: minutesIn * 60, duration: minutesLong * 60, updatedAt: at } });

test('a film stopped in the credits is not in progress', () => {
  const items = [film('gamer'), film('doom'), film('jumanji'), film('nice-guys'), film('hobbit')];
  const out = list(items, { gamer: stopped(85.3, 94.8, 5), doom: stopped(98.1, 112.7, 4), jumanji: stopped(107.4, 123.2, 3),
    'nice-guys': stopped(97.7, 116, 2), hobbit: stopped(150, 182.5, 1) });
  assert.deepEqual(out.map(i => i.id), ['nice-guys', 'hobbit'], '18 minutes left at 84%, and 32 minutes left, are still to watch');
});

test('an episode stopped in the credits offers the next one', () => {
  const items = [ep(3, 8), ep(3, 9)];
  const out = list(items, { s3e8: stopped(41.1, 46.3, 900) });
  assert.deepEqual(out.map(i => [i.id, i.upNext]), [['s3e9', true]]);
});

test('an audiobook with hours left is in progress however far through it is', () => {
  const book = { id: 'book', mediaKind: 'audio', title: 'Book', filename: 'book.m4b' };
  assert.deepEqual(list([book], { book: stopped(900, 1014.8, 9) }).map(i => i.id), ['book']);
});
