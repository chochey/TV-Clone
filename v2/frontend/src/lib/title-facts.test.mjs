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
