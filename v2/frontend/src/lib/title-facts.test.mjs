import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, playFacts, peopleOf, alsoBy, similarTo } from './title-facts.js';

test('formatSize prints GB with one decimal and MB whole', () => {
  assert.equal(formatSize(4.24 * 1024 ** 3), '4.2 GB');
  assert.equal(formatSize(700 * 1024 ** 2), '700 MB');
  assert.equal(formatSize(0), '');
  assert.equal(formatSize(undefined), '');
});

test('playFacts describes the file, how this device gets it, and subtitles', () => {
  const item = { filename: 'Heat (1995).mkv', fileSize: 8.1 * 1024 ** 3, streamMode: 'transcode',
    audioTracks: [{ label: 'English · 5.1 · AC3', isDefault: true }, { label: 'French · Stereo', isDefault: false }],
    subtitles: [{ label: 'English' }, { label: 'English — Forced (foreign dialogue)' }, { label: 'SPA [image subtitles]' }] };
  const [file, device, subs] = playFacts(item, { quality: 'auto' });
  assert.deepEqual(file, { label: 'Your file', value: 'MKV · 8.1 GB', detail: 'English · 5.1 · AC3, plus 1 more audio track' });
  assert.deepEqual(device, { label: 'On this device', value: 'Converted as it plays', detail: 'Up to 1080p (Auto quality)' });
  assert.deepEqual(subs, { label: 'Subtitles', value: '3 tracks', detail: 'English, SPA' });
});

test('playFacts follows the stream mode and the Data Saver choice', () => {
  const facts = (streamMode, quality = 'auto', extra = {}) => playFacts({ filename: 'a.mp4', streamMode, ...extra }, { quality })[1];
  assert.equal(facts('direct').value, 'Plays as is');
  assert.equal(facts('remux').value, 'Full quality');
  assert.equal(facts('transcode', 'high').detail, 'Source resolution (Full quality)');
  assert.deepEqual(facts('direct', 'low'), { label: 'On this device', value: 'Data Saver', detail: 'Converted to 720p, about 2 Mbps' });
  assert.equal(facts('unsupported', 'auto', { playbackIssue: 'Needs a compatible copy.' }).value, "Can't play yet");
  assert.equal(facts('unsupported', 'auto', { playbackIssue: 'Needs a compatible copy.' }).detail, 'Needs a compatible copy.');
  assert.equal(facts(undefined).value, 'Checking…');
});

test('playFacts says when there are no subtitles', () => {
  assert.deepEqual(playFacts({ filename: 'a.mp4', subtitles: [] })[2], { label: 'Subtitles', value: 'None', detail: 'None for this title yet' });
  assert.equal(playFacts({ filename: 'a.mp4', subtitles: [{ label: 'English' }] })[2].value, '1 track');
});

test('peopleOf splits OMDb credits and drops N/A', () => {
  assert.deepEqual(peopleOf({ director: 'Michael Mann', actors: 'Al Pacino, Robert De Niro, Val Kilmer, Jon Voight' }),
    { directors: ['Michael Mann'], actors: ['Al Pacino', 'Robert De Niro', 'Val Kilmer'] });
  assert.deepEqual(peopleOf({ director: 'N/A', actors: '' }), { directors: [], actors: [] });
});

const credits = { byId: new Map([
  ['heat', { directors: ['Michael Mann'], actors: ['Al Pacino'] }],
  ['collateral', { directors: ['Michael Mann'], actors: ['Tom Cruise'] }],
  ['thief', { directors: ['Michael Mann'], actors: ['James Caan'] }],
  ['godfather', { directors: ['Francis Ford Coppola'], actors: ['Al Pacino'] }],
]) };
const lib = [
  { id: 'heat', title: 'Heat', year: '1995', genre: 'Action, Crime, Drama', imdbRating: '8.3' },
  { id: 'collateral', title: 'Collateral', year: '2004', genre: 'Crime, Drama, Thriller', imdbRating: '7.5', watched: true },
  { id: 'thief', title: 'Thief', year: '1981', genre: 'Crime, Drama', imdbRating: '7.3' },
  { id: 'godfather', title: 'The Godfather', year: '1972', genre: 'Crime, Drama', imdbRating: '9.2' },
  { id: 'up', title: 'Up', year: '2009', genre: 'Animation, Adventure', imdbRating: '8.3' },
  { id: 'friends', title: 'Friends', showName: 'Friends', epInfo: { season: 1, episode: 1 }, genre: 'Comedy, Crime', mediaKind: 'show' },
  { id: 'book', title: 'Crime book', mediaKind: 'audio', genre: 'Crime' },
];

test('alsoBy lists the director\'s other films in the library, newest first', () => {
  assert.deepEqual(alsoBy('Michael Mann', 'heat', lib, credits).map(i => i.id), ['collateral', 'thief']);
  assert.deepEqual(alsoBy('', 'heat', lib, credits), []);
  assert.deepEqual(alsoBy('Michael Mann', 'heat', lib, null), []);
});

test('similarTo ranks same-kind titles by shared genres and cast, unwatched first, and skips the excluded', () => {
  const ids = similarTo(lib[0], lib, credits).map(i => i.id);
  assert.deepEqual(ids, ['godfather', 'thief', 'collateral']);
  assert.deepEqual(similarTo(lib[0], lib, credits, { exclude: new Set(['thief']) }).map(i => i.id), ['godfather', 'collateral']);
  assert.deepEqual(similarTo(lib[5], lib, credits).map(i => i.id), []);
});

import { bookSeries, moreByAuthor, sameSeries } from './title-facts.js';

test('bookSeries reads "Series, Book N" and its variants out of a title', () => {
  assert.deepEqual(bookSeries('We Are Legion (We Are Bob): Bobiverse, Book 1'), { name: 'Bobiverse', number: 1 });
  assert.deepEqual(bookSeries("Carl's Doomsday Scenario: Dungeon Crawler Carl, Book 2"), { name: 'Dungeon Crawler Carl', number: 2 });
  assert.deepEqual(bookSeries('The Final Empire: Mistborn Book 1'), { name: 'Mistborn', number: 1 });
  assert.deepEqual(bookSeries('The Way of Kings : Book One of the Stormlight Archive'), { name: 'Stormlight Archive', number: 1 });
  assert.deepEqual(bookSeries('Immortals: An Epic Fantasy Adventure (Essencers of Aelathia, Book 1)'), { name: 'Essencers of Aelathia', number: 1 });
  assert.deepEqual(bookSeries('Storm Cursed: Mercy Thompson Novel Series, Book 11'), { name: 'Mercy Thompson', number: 11 });
  assert.deepEqual(bookSeries('Fourth Wing (Part 1 of 2) (Dramatized Adaptation): The Empyrean, Book 1'), { name: 'The Empyrean', number: 1 });
  assert.deepEqual(bookSeries('Fourth Wing: Empyrean, Book 1'), { name: 'Empyrean', number: 1 });
  assert.deepEqual(bookSeries('Dune: Book One in the Dune Chronicles'), { name: 'Dune Chronicles', number: 1 });
  assert.deepEqual(bookSeries('The Underworld Collection: Volume 1: Underworld, Books 1-3'), { name: 'Underworld', number: 1 });
  assert.equal(bookSeries('Ready Player Two: A Novel'), null);
  assert.equal(bookSeries('Thinking, Fast and Slow'), null);
  assert.equal(bookSeries(''), null);
});

const books = [
  { id: 'bob1', mediaKind: 'audio', title: 'We Are Legion (We Are Bob): Bobiverse, Book 1', artist: 'Dennis E. Taylor' },
  { id: 'bob3', mediaKind: 'audio', title: 'All These Worlds: Bobiverse, Book 3', artist: 'Dennis E. Taylor' },
  { id: 'bob2', mediaKind: 'audio', title: 'For We Are Many: Bobiverse, Book 2', artist: 'Dennis E. Taylor', audioMetadata: { title: 'For We Are Many: Bobiverse, Book 2' } },
  { id: 'dcc1', mediaKind: 'audio', title: 'Dungeon Crawler Carl: Dungeon Crawler Carl, Book 1', artist: 'Matt Dinniman' },
  { id: 'rp1', mediaKind: 'audio', title: 'Ready Player One', artist: 'Ernest Cline' },
  { id: 'rp2', mediaKind: 'audio', title: 'Ready Player Two: A Novel', artist: 'Ernest Cline', watched: true },
  { id: 'armada', mediaKind: 'audio', title: 'Armada: A Novel', artist: 'Ernest Cline' },
  { id: 'film', mediaKind: 'movie', title: 'Ready Player One', director: 'Steven Spielberg' },
];

test('sameSeries lists the other books of the series in reading order, ignoring a leading The', () => {
  assert.deepEqual(sameSeries(books[1], books).map(b => b.id), ['bob1', 'bob2']);
  const wing = { id: 'w1', mediaKind: 'audio', title: 'Fourth Wing: Empyrean, Book 1' }, dram = { id: 'w2', mediaKind: 'audio', title: 'Fourth Wing (Dramatized Adaptation): The Empyrean, Book 1' };
  assert.deepEqual(sameSeries(wing, [wing, dram]).map(b => b.id), ['w2']);
  assert.deepEqual(sameSeries(books[0], books).map(b => b.id), ['bob2', 'bob3']);
  assert.deepEqual(sameSeries(books[4], books), []);
  assert.deepEqual(sameSeries(books[7], books), []);
});

test('moreByAuthor lists the author\'s other books, series mates excluded, unfinished first', () => {
  assert.deepEqual(moreByAuthor(books[4], books).map(b => b.id), ['armada', 'rp2']);
  assert.deepEqual(moreByAuthor(books[0], books).map(b => b.id), []);
  assert.deepEqual(moreByAuthor({ id: 'x', mediaKind: 'audio', title: 'Nothing' }, books), []);
  const narrated = { id: 'n', mediaKind: 'audio', title: 'Lock In (Narrated by Wil Wheaton)', artist: 'John Scalzi' };
  const omw = { id: 'o', mediaKind: 'audio', title: "Old Man's War", audioMetadata: { artist: ' John Scalzi ' } };
  assert.deepEqual(moreByAuthor(narrated, [...books, narrated, omw]).map(b => b.id), ['o']);
});
