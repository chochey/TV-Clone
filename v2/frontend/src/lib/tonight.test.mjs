import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting, summaryLine, timeLeft, pausedWhen, splitInProgress, rankPicks, pickReason } from './tonight.js';

const at = (s) => new Date(s).getTime();

test('the heading names the day and the part of it', () => {
  assert.equal(greeting(at('2026-10-17T21:30:00')), 'Saturday night');
  assert.equal(greeting(at('2026-10-18T09:05:00')), 'Sunday morning');
  assert.equal(greeting(at('2026-10-19T14:00:00')), 'Monday afternoon');
  assert.equal(greeting(at('2026-10-19T18:30:00')), 'Monday evening');
  assert.equal(greeting(at('2026-10-20T02:00:00')), 'Tuesday, late');
});

const film = (id, extra = {}) => ({ id, title: id, type: 'movie', mediaKind: 'movie', ...extra });
const book = (id, extra = {}) => ({ id, title: id, mediaKind: 'audio', ...extra });
const ep = (id, extra = {}) => ({ id, title: id, type: 'show', mediaKind: 'show', showName: 'Friends', epInfo: { season: 9, episode: 23 }, ...extra });

test('in-progress titles split into the newest video, the newest audiobook, and the rest', () => {
  const items = [film('a', { progress: { updatedAt: 1 } }), book('b', { progress: { updatedAt: 5 } }), ep('c', { progress: { updatedAt: 9 } }), book('d', { progress: { updatedAt: 2 } })];
  const s = splitInProgress(items);
  assert.equal(s.watching.id, 'c');
  assert.equal(s.listening.id, 'b');
  assert.deepEqual(s.others.map(i => i.id), ['d', 'a']);
  assert.deepEqual(splitInProgress([]), { watching: null, listening: null, others: [] });
});

test('the summary counts what is in progress and what arrived this week', () => {
  assert.equal(summaryLine({ watching: film('a'), listening: book('b'), others: [], addedThisWeek: 3 }), 'A film and an audiobook in progress · 3 added this week');
  assert.equal(summaryLine({ watching: ep('c'), listening: null, others: [film('a'), book('d')], addedThisWeek: 1 }), '2 videos and an audiobook in progress · 1 added this week');
  assert.equal(summaryLine({ watching: null, listening: null, others: [], addedThisWeek: 0 }), 'Nothing in progress');
  assert.equal(summaryLine({ watching: ep('c'), listening: null, others: [], addedThisWeek: 0 }), 'An episode in progress');
});

test('time left and when it was paused read like a person would say them', () => {
  // Non-breaking spaces keep each number with its unit when the line wraps.
  assert.equal(timeLeft({ currentTime: 3000, duration: 8820 }), '1\u00a0h 37\u00a0min left');
  assert.equal(timeLeft({ currentTime: 600, duration: 1320 }), '12\u00a0min left');
  assert.equal(timeLeft({ currentTime: 0, duration: 7190 }), '2\u00a0h 0\u00a0min left');
  assert.equal(timeLeft({ currentTime: 0, duration: 3590 }), '1\u00a0h 0\u00a0min left');
  assert.equal(timeLeft({ currentTime: 0, duration: 0 }), '');
  const now = at('2026-10-17T21:30:00');
  assert.equal(pausedWhen(at('2026-10-17T20:05:00'), now), 'Paused today at 8:05 PM');
  assert.equal(pausedWhen(at('2026-10-16T22:15:00'), now), 'Paused yesterday at 10:15 PM');
  assert.equal(pausedWhen(at('2026-10-15T21:12:00'), now), 'Paused Thursday at 9:12 PM');
  assert.equal(pausedWhen(at('2026-09-01T21:12:00'), now), 'Paused Sep 1');
  assert.equal(pausedWhen(0, now), '');
});

const lib = [
  film('collateral', { title: 'Collateral', watched: true, imdbRating: '7.5', genre: 'Crime, Thriller' }),
  film('heat', { title: 'Heat', imdbRating: '8.3', genre: 'Action, Crime, Drama' }),
  film('hp1', { title: "Philosopher's Stone", watched: true, imdbRating: '7.7', genre: 'Adventure' }),
  film('hp2', { title: 'Chamber of Secrets', imdbRating: '7.4', genre: 'Adventure, Family' }),
  film('meh', { title: 'Meh', imdbRating: '5.1', genre: 'Comedy' }),
  film('plain', { title: 'Plain', genre: 'Drama' }),
];
const ctx = {
  library: lib,
  collections: [{ id: 'Q1', name: 'Harry Potter', itemIds: ['hp1', 'hp2'] }],
  credits: { byId: new Map([['collateral', { directors: ['Michael Mann'], actors: [] }], ['heat', { directors: ['Michael Mann'], actors: [] }]]) },
};

test('picks that continue a collection or share a director with something watched come first', () => {
  const ranked = rankPicks(lib.filter(i => !i.watched), ctx);
  assert.deepEqual(ranked.slice(0, 2).map(i => i.id).sort(), ['heat', 'hp2']);
  assert.equal(ranked.at(-1).id, 'plain');
});

test('every pick comes with a reason in plain words', () => {
  assert.equal(pickReason(lib[3], ctx), "Next in Harry Potter: you've seen 1 of 2.");
  assert.equal(pickReason(lib[1], ctx), "Same director as Collateral, which you've seen.");
  assert.equal(pickReason(lib[4], ctx), "A comedy you haven't watched yet.");
  assert.equal(pickReason(film('x', { imdbRating: '8.1', genre: 'Drama' }), { library: [], collections: [], credits: null }), "Rated 8.1 on IMDb, and you haven't seen it.");
  assert.equal(pickReason(lib[5], { library: [], collections: [], credits: null }), "A drama you haven't watched yet.");
  assert.equal(pickReason(film('y'), { library: [], collections: [], credits: null }), "From your library, not watched yet.");
});
