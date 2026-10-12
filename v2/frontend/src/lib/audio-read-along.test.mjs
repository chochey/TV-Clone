import test from 'node:test';
import assert from 'node:assert/strict';
import { readAlongDocument, readAlongPosition } from './audio-read-along.js';
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
