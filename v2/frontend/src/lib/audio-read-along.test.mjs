import test from 'node:test';
import assert from 'node:assert/strict';
import { readAlongDocument, readAlongPosition, readAlongWordAt, readAlongWordParts } from './audio-read-along.js';
import { api } from './api.js';

const fixture = () => ({ available: true, version: 1, itemId: 'book', title: 'Book', duration: 120, chapters: [
  { id: 'one', title: 'Chapter one', start: 10, end: 60, paragraphs: [
    { id: 'a', text: 'First passage', start: 12, end: 20, page: 8 },
    { id: 'b', text: 'Untimed passage', start: null, end: null, page: 9 },
    { id: 'c', text: 'Third passage', start: 25, end: 59, page: 9 },
  ] },
  { id: 'two', title: 'Chapter two', start: 70, end: 110, paragraphs: [{ id: 'd', text: 'Last passage', start: 70, end: 105, page: 10 }] },
] });

test('read along highlights only actual intervals, including chapter changes and seeks backward', () => {
  const document = readAlongDocument(fixture(), 'book');
  assert.deepEqual(readAlongPosition(document, 12), { chapter: 0, paragraph: 0 });
  assert.deepEqual(readAlongPosition(document, 25), { chapter: 0, paragraph: 2 });
  assert.deepEqual(readAlongPosition(document, 72), { chapter: 1, paragraph: 0 });
  assert.deepEqual(readAlongPosition(document, 18), { chapter: 0, paragraph: 0 });
  for (const time of [0, 9, 60, 65, 110, 120, -1, NaN, Infinity]) assert.deepEqual(readAlongPosition(document, time), { chapter: -1, paragraph: -1 });
  for (const time of [10, 11, 20, 24, 59]) assert.deepEqual(readAlongPosition(document, time), { chapter: 0, paragraph: -1 });
  assert.deepEqual(readAlongPosition(document, 105), { chapter: 1, paragraph: -1 });
});

test('read along preserves literal book text, discards private metadata, rejects incorrect or overlapping data', () => {
  const raw = fixture(); raw.source = '/private/book.pdf'; raw.chapters[0].paragraphs[0].text = '<script>literal text</script>';
  const document = readAlongDocument(raw, 'book');
  assert.equal(document.source, undefined);
  assert.equal(document.chapters[0].paragraphs[0].text, '<script>literal text</script>');
  assert.equal(readAlongDocument({ available: false }, 'book'), null);
  assert.throws(() => readAlongDocument(raw, 'other'));
  for (const modify of [
    value => value.version = 9,
    value => value.chapters[1].start = 50,
    value => value.chapters[0].paragraphs[2].start = 18,
    value => value.chapters[0].paragraphs[0].end = 65,
    value => value.chapters[0].paragraphs[2].id = 'a',
  ]) { const value = fixture(); modify(value); assert.throws(() => readAlongDocument(value, 'book')); }
});

test('read along API uses authenticated on-demand endpoint and forwards cancellation', async () => {
  const original = globalThis.fetch, controller = new AbortController();
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/audio/read-along/book%2Fone');
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.signal, controller.signal);
      return { ok: true, json: async () => ({ available: false }) };
    };
    assert.deepEqual(await api.audioReadAlong('book/one', controller.signal), { available: false });
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ error: 'later' }) });
    await assert.rejects(api.audioReadAlong('book'), error => error.status === 503);
  } finally { globalThis.fetch = original; }
});

test('word timing follows exact intervals and leaves pauses and unmatched text unhighlighted', () => {
  const raw = fixture(), paragraph = raw.chapters[0].paragraphs[0];
  paragraph.words = [[0, 5, 12, 12.25], [6, 13, 12.4, 13.5]];
  const words = readAlongDocument(raw, 'book').chapters[0].paragraphs[0].words;
  assert.equal(readAlongWordAt(words, 12), 0);
  assert.equal(readAlongWordAt(words, 12.249), 0);
  assert.equal(readAlongWordAt(words, 12.25), -1);
  assert.equal(readAlongWordAt(words, 12.4), 1);
  assert.equal(readAlongWordAt(words, 13.499), 1);
  assert.equal(readAlongWordAt(words, 12.1), 0);
  for (const time of [0, 11.9, 12.3, 13.5, 20, NaN, Infinity]) assert.equal(readAlongWordAt(words, time), -1);
  assert.equal(readAlongWordAt(undefined, 12), -1);
});

test('short gaps between consecutive words hold the previous highlight without anticipating the next', () => {
  const text = 'One\t two\nthree four';
  const words = [[0, 3, 1, 1.5], [5, 8, 1.75, 2], [9, 14, 2.1, 2.5], [15, 19, 3, 3.5]];
  for (const time of [1.5, 1.6, 1.749]) assert.equal(readAlongWordAt(words, time, text), 0);
  assert.equal(readAlongWordAt(words, 1.75, text), 1);
  assert.equal(readAlongWordAt(words, 2.05, text), 1);
  assert.equal(readAlongWordAt(words, 2.1, text), 2);
  // A seek uses only its new clock position, with no remembered highlight.
  assert.equal(readAlongWordAt(words, 3.2, text), 3);
  assert.equal(readAlongWordAt(words, 1.6, text), 0);
  for (const time of [0, 0.999, 2.5, 2.6, 2.999, 3.5, 99, NaN, Infinity]) {
    assert.equal(readAlongWordAt(words, time, text), -1);
  }
  assert.equal(readAlongWordAt(words, 1.6), -1);
  const longerGap = [[0, 3, 1, 1.5], [5, 8, 1.751, 2]];
  assert.equal(readAlongWordAt(longerGap, 1.6, text), -1);
});

test('gap smoothing preserves omitted words, punctuation boundaries and UTF-16 offsets', () => {
  for (const text of ['One missing two', 'One, two', 'One\u2014two', 'Onetwo']) {
    const words = [[0, 3, 1, 1.5], [text.indexOf('two'), text.length, 1.6, 2]];
    assert.equal(readAlongWordAt(words, 1.55, text), -1);
    assert.equal(readAlongWordAt(words, 1.6, text), 1);
  }
  const text = '\ud83d\udc4b\u00a0caf\u00e9\u2003next';
  const words = [[0, 2, 1, 1.5], [3, 7, 1.6, 2], [8, 12, 2.1, 2.5]];
  assert.equal(readAlongWordAt(words, 1.55, text), 0);
  assert.equal(readAlongWordAt(words, 2.05, text), 1);
  assert.equal(readAlongWordAt(words, 2.1, text), 2);
});

test('word spans preserve punctuation, whitespace, Unicode and unmatched text exactly', () => {
  const raw = fixture(), paragraph = raw.chapters[0].paragraphs[0];
  paragraph.text = '😀 “Hello,”\t  reader.\n<unmatched> words remain.';
  paragraph.words = ['Hello', 'reader', 'remain'].map((word, index) => [paragraph.text.indexOf(word), paragraph.text.indexOf(word) + word.length, 12 + index, 12.5 + index]);
  const parsed = readAlongDocument(raw, 'book').chapters[0].paragraphs[0], parts = readAlongWordParts(parsed);
  assert.equal(parts.map(part => part.text).join(''), paragraph.text);
  assert.deepEqual(parts.filter(part => part.word >= 0).map(part => part.text), ['Hello', 'reader', 'remain']);
  assert.ok(parts.some(part => part.word === -1 && part.text.includes('<unmatched>')));
  assert.deepEqual(readAlongWordParts({ text: 'Paragraph fallback' }), []);
  assert.deepEqual(readAlongWordParts({ text: 'Paragraph fallback', words: [] }), []);
});

test('malformed word ranges cannot split Unicode or extend beyond paragraph text and timing', () => {
  const invalid = [
    [[-1, 5, 12, 13]], [[0.5, 5, 12, 13]], [[0, 0, 12, 13]], [[0, 99, 12, 13]], [[0, 5, 12, 12]],
    [[0, 5, 11, 13]], [[0, 5, 12, 21]], [[0, 5, 12, Infinity]], [[0, 5, 12, 13, 'extra']],
    [[0, 5, 12, 13], [4, 13, 14, 15]], [[0, 5, 12, 13], [6, 13, 12.5, 15]], [[5, 6, 12, 13]],
  ];
  for (const words of invalid) {
    const raw = fixture(); raw.chapters[0].paragraphs[0].words = words;
    assert.throws(() => readAlongDocument(raw, 'book'), /Invalid word timing/);
  }
  const untimed = fixture(); untimed.chapters[0].paragraphs[1].words = [[0, 5, 20, 21]];
  assert.throws(() => readAlongDocument(untimed, 'book'), /Invalid word timing/);
  for (const range of [[0, 1, 12, 13], [1, 2, 12, 13]]) {
    const raw = fixture(); raw.chapters[0].paragraphs[0].text = '😀 word'; raw.chapters[0].paragraphs[0].words = [range];
    assert.throws(() => readAlongDocument(raw, 'book'), /Invalid word timing/);
  }
});
