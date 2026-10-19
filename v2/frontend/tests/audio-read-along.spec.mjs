import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url)), origin = 'http://tvclone.test';
const book = { id: 'book', title: 'Fixture audiobook', filename: 'book.wav', mediaKind: 'audio', type: 'audio', streamMode: 'direct', subtitles: [],
  progress: { currentTime: 8, duration: 60, percent: 13, updatedAt: 100 },
  audioMetadata: { title: 'Fixture audiobook', artist: 'Fixture reader', duration: 60 } };
function document() {
  return { available: true, version: 1, itemId: 'book', title: 'Fixture audiobook', duration: 60,
    chapters: [0, 1, 2].map(index => ({ id: `ch${index}`, title: `Chapter ${index + 1}`, start: index * 20, end: index * 20 + 18,
      paragraphs: Array.from({ length: 16 }, (_, paragraph) => ({ id: `${index}-${paragraph}`, start: index * 20 + paragraph + 1, end: index * 20 + paragraph + 2,
        page: index * 10 + paragraph + 1,
        text: `Chapter ${index + 1} passage ${paragraph + 1}. The reader follows the spoken story. ${'This is a readable paragraph with enough text to wrap comfortably on a phone. '.repeat(3)}` })) })) };
}
function wav() {
  const size = 60 * 8000 * 2, body = Buffer.alloc(44 + size);
  body.write('RIFF'); body.writeUInt32LE(size + 36, 4); body.write('WAVEfmt ', 8); body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22); body.writeUInt32LE(8000, 24); body.writeUInt32LE(16000, 28);
  body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34); body.write('data', 36); body.writeUInt32LE(size, 40); return body;
}
async function fixture(page) {
  const html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
  const state = { requests: 0, errors: [], response: document(), status: 200, delay: null };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/stream/book') {
      const body = wav(), range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      if (range) { const start = Number(range[1]), end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
        return route.fulfill({ status: 206, contentType: 'audio/wav', body: body.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` } }); }
      return route.fulfill({ contentType: 'audio/wav', body });
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (url.pathname === '/api/health') body = { ready: true };
      else if (url.pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'listener', name: 'Listener' };
      else if (url.pathname === '/api/library') body = [book];
      else if (url.pathname === '/api/library/sections') body = { ok: true, sections: [] };
      else if (url.pathname === '/api/item/book') body = book;
      else if (url.pathname === '/api/audio/preferences') body = { speed: 1 };
      else if (url.pathname === '/api/audio/bookmarks/book') body = { bookmarks: [] };
      else if (url.pathname === '/api/audio/read-along/book') {
        state.requests++; if (state.delay) await state.delay;
        return route.fulfill({ status: state.status, json: state.response });
      } else if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
      else if (url.pathname === '/api/notifications') body = { notifications: [] };
      else if (url.pathname === '/api/requests') body = { requests: [] };
      return route.fulfill({ json: body });
    }
    if (/^\/(poster|backdrop|omdb-poster|audio-artwork)\//.test(url.pathname)) return route.fulfill({ status: 404 });
    const file = url.pathname.startsWith('/assets/') ? path.join(dist, url.pathname) : path.join(dist, 'index.html');
    return route.fulfill({ body: file.endsWith('index.html') ? html.replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : await fs.readFile(file),
      contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(`${origin}/title/book`);
  await page.getByRole('button', { name: /^Resume listening/ }).click();
  await expect.poll(() => page.locator('audio').evaluate(audio => !audio.paused && audio.readyState >= 3)).toBe(true);
  return state;
}
async function position(page, time) { await page.locator('audio').evaluate((audio, time) => { audio.pause(); audio.currentTime = time; audio.dispatchEvent(new Event('timeupdate')); }, time); }
async function afterPaint(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
function shortDocument() {
  const value = document();
  for (const chapter of value.chapters) for (const [index, passage] of chapter.paragraphs.entries()) {
    passage.text = `${chapter.title} passage ${index + 1}. A short passage.`;
  }
  return value;
}
function wordDocument() {
  const text = '“Hello,”\t  reader.\nUnmatched text stays. 👋';
  const words = ['Hello', 'reader', 'stays'].map((word, index) => [text.indexOf(word), text.indexOf(word) + word.length, 1 + index * 2, 2 + index * 2]);
  return { available: true, version: 1, itemId: 'book', title: 'Fixture audiobook', duration: 60, chapters: [
    { id: 'words', title: 'Word timing', start: 0, end: 60, paragraphs: [
      { id: 'words-one', text, start: 1, end: 10, words },
      { id: 'words-two', text: 'A second synchronized passage.', start: 11, end: 20, words: [[2, 8, 11, 12], [9, 21, 13, 14]] },
      { id: 'paragraph-only', text: 'This passage still follows at paragraph level.', start: 21, end: 30 },
    ] },
  ] };
}
function longWordDocument() {
  const text = Array.from({ length: 120 }, (_, index) => `word${String(index).padStart(3, '0')}`).join(' ');
  const words = [...text.matchAll(/\S+/g)].map((match, index) => [match.index, match.index + match[0].length, 1 + index * .4, 1.32 + index * .4]);
  return { available: true, version: 1, itemId: 'book', title: 'Fixture audiobook', duration: 60, chapters: [
    { id: 'long-words', title: 'A long paragraph', start: 0, end: 60, paragraphs: [
      { id: 'long-words-one', text, start: 1, end: 50, words },
      { id: 'long-after', text: 'The next paragraph stays available below the long one.', start: 51, end: 59 },
    ] },
  ] };
}
async function spokenIsReadable(text) {
  return text.evaluate(element => {
    const spoken = element.querySelector('.spoken-current');
    if (!spoken) return false;
    const pane = element.getBoundingClientRect(), bounds = spoken.getClientRects()[0];
    return bounds.top >= Math.max(0, pane.top) + 10 && bounds.bottom <= Math.min(window.innerHeight, pane.top + element.clientHeight) - 20;
  });
}
async function watchScroll(text) {
  await text.evaluate(element => {
    const scrollTo = element.scrollTo.bind(element);
    element.readerScrollCalls = [];
    element.scrollTo = options => { element.readerScrollCalls.push(options); scrollTo(options); };
  });
}
async function scrollCalls(text) { return text.evaluate(element => element.readerScrollCalls); }
async function activeIsReadable(text) {
  return text.evaluate(element => {
    const paragraph = element.querySelector('[aria-current="true"] p');
    if (!paragraph) return false;
    const pane = element.getBoundingClientRect(), bounds = paragraph.getBoundingClientRect();
    return bounds.top >= pane.top + 10 && bounds.top + Math.min(bounds.height, element.clientHeight * .65) <= pane.top + element.clientHeight - 20;
  });
}

test('reading loads on demand and follows actual time without replacing or interrupting audio', async ({ page }) => {
  const state = await fixture(page), audio = page.locator('audio');
  expect(state.requests).toBe(0);
  await audio.evaluate(audio => audio.dataset.identity = 'same-player');
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true });
  await expect(reader.getByRole('region', { name: 'Book text' })).toBeVisible();
  expect(state.requests).toBe(1);
  expect(await audio.evaluate(audio => audio.paused)).toBe(false);
  await position(page, 8.25);
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 8.');
  const text = reader.getByRole('region', { name: 'Book text' });
  await text.evaluate(element => element.scrollTop = 5);
  await position(page, 8.5);
  expect(await text.evaluate(element => element.scrollTop)).toBe(5);
  await position(page, 23.2);
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('1');
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 2 passage 3.');
  await expect(reader.locator('.passage')).toHaveCount(16);
  await position(page, 19);
  await expect(reader.locator('[aria-current="true"]')).toHaveCount(0);
  await expect(reader.getByText(/Text is not synchronized at this point/)).toBeVisible();
  await page.getByRole('button', { name: 'Play audio', exact: true }).click();
  await page.getByRole('button', { name: 'Minimize audio player' }).click();
  await expect(audio).toHaveCount(1);
  expect(await audio.evaluate(audio => audio.dataset.identity)).toBe('same-player');
  expect(await audio.evaluate(audio => audio.paused)).toBe(false);
  await page.getByRole('button', { name: 'Expand audio player' }).click();
  await expect(reader).toBeVisible(); expect(state.requests).toBe(1); expect(state.errors).toEqual([]);
});

test('browsing and user scrolling stop following without seeking; explicit listening and resume restore it', async ({ page }) => {
  const state = await fixture(page); await position(page, 8.25);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 8.');
  await reader.getByRole('button', { name: 'Next chapter' }).click();
  expect(await page.locator('audio').evaluate(audio => audio.currentTime)).toBe(8.25);
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('1');
  await expect(reader.locator('[aria-current="true"]')).toHaveCount(0);
  await reader.getByRole('button', { name: 'Resume following' }).click();
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('0');
  await text.dispatchEvent('wheel', { deltaY: 120 });
  await expect(reader.getByRole('button', { name: 'Resume following' })).toBeVisible();
  await position(page, 42.5);
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('0');
  await reader.getByRole('button', { name: 'Resume following' }).click();
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('2');
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 3 passage 2.');
  await reader.getByLabel('Reading chapter').selectOption('0');
  await reader.getByRole('button', { name: 'Listen from this passage at 0:01', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate(audio => audio.currentTime)).toBe(1);
  await expect(reader.getByText('Following narration', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('phone reader is high contrast, supports larger type and keyboard browsing without toggling audio', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page); await position(page, 8.25);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(text).toBeVisible();
  await reader.getByRole('button', { name: 'Increase text size' }).click();
  expect(await reader.locator('.passage p').first().evaluate(element => getComputedStyle(element).fontSize)).toBe('21px');
  const box = await reader.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await text.focus(); await page.keyboard.press('PageDown');
  await expect(reader.getByRole('button', { name: 'Resume following' })).toBeVisible();
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(true);
  await page.screenshot({ path: '/tmp/readalong-phone.png', fullPage: true });
  expect(state.errors).toEqual([]);
});

test('missing text and failed or cancelled loads leave playback usable and retry recovers', async ({ page }) => {
  const state = await fixture(page); state.status = 503;
  const toggle = page.getByRole('button', { name: 'Read along', exact: true }); await toggle.click();
  await expect(page.getByText(/Could not load the reading text/)).toBeVisible();
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(false);
  state.status = 200; state.response = { available: false };
  await page.getByRole('button', { name: 'Retry reading text' }).click();
  // No prepared text at all: say so plainly, and offer no "Check again" that cannot help.
  await expect(page.getByText('Read along isn’t set up for this book')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toHaveCount(0);
  await toggle.click(); state.response = { available: false, retryable: true }; await toggle.click();
  await expect(page.getByText('Reading text isn’t ready yet')).toBeVisible();
  await toggle.click(); state.response = document(); let resolve; state.delay = new Promise(done => resolve = done);
  await toggle.click(); await expect(page.getByText('Loading reading text…')).toBeVisible();
  await toggle.click(); resolve(); state.delay = null;
  await expect(page.getByRole('region', { name: 'Read along', exact: true })).toHaveCount(0);
  await toggle.click(); await expect(page.getByRole('region', { name: 'Book text' })).toBeVisible();
  expect(await page.locator('audio').evaluate(audio => audio.paused)).toBe(false);
  expect(state.errors).toEqual([]);
});

test('visible passages stay still and ordinary progression scrolls only when the next passage needs room', async ({ page }) => {
  const state = await fixture(page); state.response = shortDocument(); await position(page, 1.25);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 1.'); await afterPaint(page);
  await watchScroll(text);
  const start = await text.evaluate(element => element.scrollTop);
  const outside = await text.evaluate(element => {
    const pane = element.getBoundingClientRect();
    return [...element.querySelectorAll('.passage p')].findIndex(passage => passage.getBoundingClientRect().bottom > pane.top + element.clientHeight - 24);
  });
  expect(outside).toBeGreaterThan(1);
  const outer = await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => ({ top: element.scrollTop, page: window.scrollY }));
  for (let index = 1; index < outside; index++) {
    await position(page, index + 1.25);
    await expect(reader.locator('[aria-current="true"]')).toContainText(`Chapter 1 passage ${index + 1}.`); await afterPaint(page);
    expect(await text.evaluate(element => element.scrollTop)).toBe(start);
    expect(await scrollCalls(text)).toEqual([]);
  }
  await position(page, outside + 1.25);
  await expect(reader.locator('[aria-current="true"]')).toContainText(`Chapter 1 passage ${outside + 1}.`);
  await expect.poll(async () => (await scrollCalls(text)).length).toBe(1);
  const [advance] = await scrollCalls(text); expect(advance.behavior).toBe('smooth');
  await expect.poll(() => text.evaluate(element => Math.abs(element.scrollTop - element.readerScrollCalls[0].top))).toBeLessThan(2);
  expect(await activeIsReadable(text)).toBe(true);
  const settled = await text.evaluate(element => element.scrollTop);
  for (const fraction of [.4, .6, .8]) { await position(page, outside + 1 + fraction); await afterPaint(page); }
  expect(await text.evaluate(element => element.scrollTop)).toBe(settled); expect((await scrollCalls(text)).length).toBe(1);
  expect(await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => ({ top: element.scrollTop, page: window.scrollY }))).toEqual(outer);
  expect(state.errors).toEqual([]);
});

test('highlight-only mode stays put through passages and timing gaps and remembers the choice after reopening', async ({ page }) => {
  const state = await fixture(page); state.response = shortDocument(); await position(page, 2.25);
  const toggle = page.getByRole('button', { name: 'Read along', exact: true }); await toggle.click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 2.');
  await reader.getByRole('checkbox', { name: 'Auto-scroll' }).uncheck();
  await text.evaluate(element => element.scrollTop = 55); await afterPaint(page); await watchScroll(text);
  const before = await text.boundingBox();
  await position(page, 3.25); await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 3.'); await afterPaint(page);
  expect(await text.evaluate(element => element.scrollTop)).toBe(55);
  await position(page, 17.5); await expect(reader.getByText(/Text is not synchronized at this point/)).toBeVisible(); await afterPaint(page);
  expect(await text.boundingBox()).toEqual(before); expect(await text.evaluate(element => element.scrollTop)).toBe(55);
  await position(page, 23.25); await afterPaint(page);
  await expect(reader.getByLabel('Reading chapter')).toHaveValue('0'); expect(await text.evaluate(element => element.scrollTop)).toBe(55);
  expect(await scrollCalls(text)).toEqual([]);
  await page.locator('audio').evaluate(audio => audio.dataset.identity = 'highlight-only-player');
  await toggle.click(); await toggle.click(); await expect(reader.getByRole('checkbox', { name: 'Auto-scroll' })).not.toBeChecked();
  await expect(reader.getByText('Highlight only · scroll at your own pace')).toBeVisible(); await afterPaint(page);
  expect(await text.evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.locator('audio').evaluate(audio => ({ identity: audio.dataset.identity, time: audio.currentTime }))).toEqual({ identity: 'highlight-only-player', time: 23.25 });
  await reader.getByRole('checkbox', { name: 'Auto-scroll' }).check(); await expect.poll(() => activeIsReadable(text)).toBe(true);
  await expect(reader.getByText('Following narration', { exact: true })).toBeVisible(); expect(state.errors).toEqual([]);
});

test('reduced motion and distant seeks position the current passage without animated travel', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await fixture(page); state.response = shortDocument(); await position(page, 1.25);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 1.'); await afterPaint(page); await watchScroll(text);
  for (let index = 2; index <= 8; index++) { await position(page, index + .25); await afterPaint(page); }
  expect((await scrollCalls(text)).length).toBeGreaterThan(0); expect((await scrollCalls(text)).every(call => call.behavior === 'instant')).toBe(true);
  expect(await activeIsReadable(text)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await text.evaluate(element => element.readerScrollCalls = []);
  await position(page, 41.25); await expect(reader.getByLabel('Reading chapter')).toHaveValue('2'); await afterPaint(page);
  expect(await activeIsReadable(text)).toBe(true);
  await position(page, 1.25); await expect(reader.getByLabel('Reading chapter')).toHaveValue('0'); await afterPaint(page);
  expect(await activeIsReadable(text)).toBe(true); expect((await scrollCalls(text)).length).toBeGreaterThan(0);
  expect((await scrollCalls(text)).every(call => call.behavior === 'instant')).toBe(true); expect(state.errors).toEqual([]);
});

test('a long passage on a phone stays stable at large text size and manual browsing resumes deliberately', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page); await position(page, 8.25);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(reader.locator('[aria-current="true"]')).toContainText('Chapter 1 passage 8.');
  const larger = reader.getByRole('button', { name: 'Increase text size' });
  for (let count = 0; count < 5; count++) await larger.click();
  await expect(larger).toBeDisabled(); await afterPaint(page);
  expect(await text.evaluate(element => element.querySelector('[aria-current="true"] p').getBoundingClientRect().height > element.clientHeight)).toBe(true);
  expect(await activeIsReadable(text)).toBe(true); await watchScroll(text);
  const fixed = await text.evaluate(element => element.scrollTop);
  for (const time of [8.4, 8.55, 8.7, 8.85]) { await position(page, time); await afterPaint(page); }
  expect(await text.evaluate(element => element.scrollTop)).toBe(fixed); expect(await scrollCalls(text)).toEqual([]);
  await text.dispatchEvent('touchmove'); await expect(reader.getByRole('button', { name: 'Resume following' })).toBeVisible();
  await text.evaluate(element => element.scrollTop += 125); const browsed = await text.evaluate(element => element.scrollTop);
  await position(page, 9.25); await afterPaint(page); expect(await text.evaluate(element => element.scrollTop)).toBe(browsed);
  await reader.getByRole('button', { name: 'Resume following' }).click(); await expect.poll(() => activeIsReadable(text)).toBe(true);
  expect(await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await reader.screenshot({ path: '/tmp/readalong-phone-stable.png' });
  expect(state.errors).toEqual([]);
});

test('spoken words follow seeks with exact text, bridged untimed runs, paragraph fallback and no extra scrolling or layout movement', async ({ page }) => {
  const state = await fixture(page); state.response = wordDocument(); await position(page, 1.2);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  const spoken = reader.locator('.spoken-current');
  await expect(spoken).toHaveText('Hello'); await afterPaint(page); await watchScroll(text);
  expect(await reader.locator('.passage p').first().textContent()).toBe(state.response.chapters[0].paragraphs[0].text);
  // Hello, reader, stays, plus "Unmatched text" bridged between reader (ends 4 s) and stays (starts 5 s).
  expect(await reader.locator('.spoken-word').count()).toBe(4);
  const bounds = await reader.locator('.passage p').first().boundingBox(), scroll = await text.evaluate(element => element.scrollTop);
  await position(page, 3.2); await expect(spoken).toHaveText('reader');
  await position(page, 4.5); await expect(spoken).toHaveText('Unmatched text');
  await position(page, 2.2); await expect(spoken).toHaveCount(0);
  await expect(reader.locator('[aria-current="true"]')).toContainText('Hello');
  await position(page, 5.2); await expect(spoken).toHaveText('stays');
  await position(page, 1.2); await expect(spoken).toHaveText('Hello'); await afterPaint(page);
  expect(await reader.locator('.passage p').first().boundingBox()).toEqual(bounds);
  expect(await text.evaluate(element => element.scrollTop)).toBe(scroll); expect(await scrollCalls(text)).toEqual([]);
  await reader.getByRole('checkbox', { name: 'Auto-scroll' }).uncheck(); await watchScroll(text);
  await position(page, 11.2); await expect(spoken).toHaveText('second');
  // "passage." is bridged between the last timed word (14 s) and the paragraph end (20 s).
  expect(await reader.locator('.spoken-word').count()).toBe(3);
  await position(page, 15); await expect(spoken).toHaveText('passage.');
  await position(page, 21.2); await expect(spoken).toHaveCount(0);
  await expect(reader.locator('[aria-current="true"]')).toContainText('paragraph level');
  expect(await reader.locator('.spoken-word').count()).toBe(0); expect(await scrollCalls(text)).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('brief gaps keep consecutive words steady, an omitted word is bridged between its neighbours, and pauses stay unhighlighted', async ({ page }) => {
  const state = await fixture(page); state.response = wordDocument();
  const paragraph = state.response.chapters[0].paragraphs[0];
  paragraph.text = 'First second omitted last after.';
  paragraph.words = [[0, 5, 1, 2], [6, 12, 2.1, 3], [21, 25, 3.1, 4], [26, 31, 5, 6]];
  await position(page, 1.2);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  const spoken = reader.locator('.spoken-current');
  await expect(spoken).toHaveText('First'); await afterPaint(page); await watchScroll(text);
  const bounds = await reader.locator('.passage p').first().boundingBox(), scroll = await text.evaluate(element => element.scrollTop);
  await position(page, 2.05); await expect(spoken).toHaveText('First');
  await position(page, 2.1); await expect(spoken).toHaveText('second');
  await position(page, 3.05); await expect(spoken).toHaveText('omitted');
  await position(page, 3.2); await expect(spoken).toHaveText('last');
  await position(page, 4.05); await expect(spoken).toHaveCount(0);
  await position(page, 5.2); await expect(spoken).toHaveText('after');
  await position(page, 6); await expect(spoken).toHaveCount(0);
  await position(page, 2.05); await expect(spoken).toHaveText('First'); await afterPaint(page);
  expect(await reader.locator('.passage p').first().boundingBox()).toEqual(bounds);
  expect(await text.evaluate(element => element.scrollTop)).toBe(scroll); expect(await scrollCalls(text)).toEqual([]);
  expect(await reader.locator('.passage p').first().textContent()).toBe(paragraph.text);
  expect(state.errors).toEqual([]);
});

test('word highlighting reads the media clock between timeupdate events and keeps pause, speed and minimization stable', async ({ page }) => {
  const state = await fixture(page); state.response = wordDocument(); await position(page, 1.2);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), audio = page.locator('audio');
  await expect(reader.locator('.spoken-current')).toHaveText('Hello');
  await audio.evaluate(media => {
    window.readerClock = 1.2;
    Object.defineProperty(media, 'currentTime', { configurable: true, get: () => window.readerClock });
    media.addEventListener('timeupdate', event => event.stopImmediatePropagation(), true);
    media.dataset.identity = 'word-clock';
  });
  await page.getByRole('button', { name: 'Play audio', exact: true }).click();
  await page.evaluate(() => window.readerClock = 3.2);
  await expect(reader.locator('.spoken-current')).toHaveText('reader');
  await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('2');
  expect(await audio.evaluate(media => media.playbackRate)).toBe(2);
  await page.evaluate(() => window.readerClock = 5.2);
  await expect(reader.locator('.spoken-current')).toHaveText('stays');
  await page.getByRole('button', { name: 'Pause audio', exact: true }).click(); await afterPaint(page);
  await page.evaluate(() => window.readerClock = 3.2); await afterPaint(page);
  await expect(reader.locator('.spoken-current')).toHaveText('stays');
  await audio.evaluate(media => media.dispatchEvent(new Event('seeked')));
  await expect(reader.locator('.spoken-current')).toHaveText('reader');
  await page.getByRole('button', { name: 'Play audio', exact: true }).click();
  await page.getByRole('button', { name: 'Minimize audio player' }).click();
  await page.evaluate(() => window.readerClock = 1.2); await afterPaint(page);
  expect(await audio.evaluate(media => media.dataset.identity)).toBe('word-clock'); expect(await audio.evaluate(media => media.paused)).toBe(false);
  await page.getByRole('button', { name: 'Expand audio player' }).click();
  await expect(reader.locator('.spoken-current')).toHaveText('Hello');
  expect(await audio.count()).toBe(1); expect(state.errors).toEqual([]);
});

test('partial word preparation is explained and refreshing adds chapters without replacing audio', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page); state.response = shortDocument();
  state.response.chapters[0].paragraphs[0].words = [[0, 7, 1, 1.5]];
  await position(page, 1.2);
  await page.locator('audio').evaluate(media => media.dataset.identity = 'partial-word-player');
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true });
  await expect(reader.getByText(/Word highlights available in 1 of 3 chapters/)).toBeVisible();
  await expect(reader.locator('.spoken-current')).toHaveText('Chapter');
  for (const chapter of state.response.chapters) chapter.paragraphs[0].words = [[0, 7, chapter.paragraphs[0].start, chapter.paragraphs[0].start + .5]];
  await reader.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(reader.locator('.spoken-current')).toHaveText('Chapter');
  await expect(reader.getByText(/Word highlights available in/)).toHaveCount(0);
  expect(await page.locator('audio').evaluate(media => ({ identity: media.dataset.identity, position: media.currentTime, paused: media.paused }))).toEqual({ identity: 'partial-word-player', position: 1.2, paused: true });
  expect(await reader.locator('.spoken-word').count()).toBe(2); expect(state.requests).toBe(2);
  await position(page, 1.7); await expect(reader.locator('.spoken-current')).toHaveText('1 passage 1. A short passage.');
  const box = await reader.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await reader.screenshot({ path: '/tmp/readalong-phone-word.png' });
  expect(state.errors).toEqual([]);
});


test('phone long paragraphs advance by readable lines without moving controls and honor manual browsing', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const state = await fixture(page); state.response = longWordDocument(); await position(page, 1.05);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true }), text = reader.getByRole('region', { name: 'Book text' });
  await expect(reader.locator('.spoken-current')).toHaveText('word000');
  const larger = reader.getByRole('button', { name: 'Increase text size' });
  for (let count = 0; count < 5; count++) await larger.click();
  await expect(larger).toBeDisabled();
  // The player and book pane have independent scrolling. Bring the reader into
  // view once, then ensure narration never scrolls the outer controls for us.
  await text.scrollIntoViewIfNeeded(); await afterPaint(page);
  await reader.getByRole('checkbox', { name: 'Auto-scroll' }).uncheck();
  await reader.getByRole('checkbox', { name: 'Auto-scroll' }).check();
  await text.scrollIntoViewIfNeeded(); await position(page, 1.05); await afterPaint(page);
  await expect.poll(() => spokenIsReadable(text)).toBe(true);
  expect(await text.evaluate(element => element.querySelector('[aria-current="true"] p').clientHeight > element.clientHeight * 3)).toBe(true);
  expect(await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await text.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const outer = await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => ({ top: element.scrollTop, page: window.scrollY }));
  await watchScroll(text);
  const outside = await text.evaluate(element => {
    const pane = element.getBoundingClientRect(), bottom = Math.min(innerHeight, pane.top + element.clientHeight) - 28;
    return [...element.querySelectorAll('.spoken-word')].findIndex(word => word.getClientRects()[0].bottom > bottom);
  });
  expect(outside).toBeGreaterThan(4);
  for (let index = 1; index < outside; index++) { await position(page, 1.05 + index * .4); await afterPaint(page); }
  expect(await scrollCalls(text)).toEqual([]);
  await position(page, 1.05 + outside * .4);
  await expect(reader.locator('.spoken-current')).toHaveText(`word${String(outside).padStart(3, '0')}`);
  await expect.poll(async () => (await scrollCalls(text)).length).toBe(1);
  // The following word arrives while the smooth advance may still be running.
  // It must not repeatedly restart the same animation at higher playback speeds.
  await position(page, 1.05 + (outside + 1) * .4); await afterPaint(page);
  expect((await scrollCalls(text)).length).toBe(1);
  await expect.poll(() => spokenIsReadable(text)).toBe(true);
  const [advance] = await scrollCalls(text); expect(advance.behavior).toBe('smooth');
  await expect.poll(() => text.evaluate(element => Math.abs(element.scrollTop - element.readerScrollCalls[0].top))).toBeLessThan(2);
  const settled = await text.evaluate(element => element.scrollTop);
  expect(settled).toBeGreaterThan(100);
  // Paused narration and the small acoustic gap keep the previous word steady.
  await position(page, 1.35 + (outside + 1) * .4); await afterPaint(page);
  await expect(reader.locator('.spoken-current')).toHaveText(`word${String(outside + 1).padStart(3, '0')}`);
  expect(await text.evaluate(element => element.scrollTop)).toBe(settled);
  expect((await scrollCalls(text)).length).toBe(1);
  expect(await page.getByRole('dialog', { name: 'Audio player' }).evaluate(element => ({ top: element.scrollTop, page: window.scrollY }))).toEqual(outer);
  await text.dispatchEvent('touchmove'); await expect(reader.getByRole('button', { name: 'Resume following' })).toBeVisible();
  await text.evaluate(element => element.scrollTop += 100); const browsed = await text.evaluate(element => element.scrollTop);
  await position(page, 45.05); await afterPaint(page); expect(await text.evaluate(element => element.scrollTop)).toBe(browsed);
  await reader.getByRole('button', { name: 'Resume following' }).click(); await text.scrollIntoViewIfNeeded();
  await expect.poll(() => spokenIsReadable(text)).toBe(true);
  await reader.screenshot({ path: '/tmp/readalong-phone-long-words.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await watchScroll(text);
  await position(page, 1.05); await expect.poll(() => spokenIsReadable(text)).toBe(true);
  expect((await scrollCalls(text)).every(call => call.behavior === 'instant')).toBe(true);
  await reader.getByRole('checkbox', { name: 'Auto-scroll' }).uncheck(); await watchScroll(text);
  await position(page, 45.05); await afterPaint(page); expect(await scrollCalls(text)).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('a chapter without words explains paragraph-only highlighting without pretending preparation is running', async ({ page }) => {
  const state = await fixture(page); state.response = shortDocument();
  state.response.chapters[0].paragraphs[0].words = [[0, 7, 1, 1.5]]; await position(page, 23.2);
  await page.getByRole('button', { name: 'Read along', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Read along', exact: true });
  await expect(reader.getByText('Paragraph highlights in this chapter', { exact: true })).toBeVisible();
  await expect(reader.getByRole('status')).toHaveText('This chapter has paragraph highlights only. Word timing is not available here yet.');
  await position(page, 1.2); await expect(reader.locator('.spoken-current')).toHaveText('Chapter');
  await expect(reader.getByText('This chapter has paragraph highlights only.', { exact: false })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});
