// Real native audio decoding against an in-memory WAV; all requests are mocked.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const audioItem = { id: 'podcast', title: 'Test podcast', filename: 'Test podcast.wav', type: 'custom-podcasts',
  mediaKind: 'audio', sectionId: 'podcasts', streamMode: 'direct', subtitles: [], progress: { currentTime: 8, duration: 60, percent: 13 } };

function wav() {
  const size = 60 * 8000 * 2, body = Buffer.alloc(44 + size);
  body.write('RIFF'); body.writeUInt32LE(size + 36, 4); body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8000, 24); body.writeUInt32LE(16000, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34);
  body.write('data', 36); body.writeUInt32LE(size, 40); return body;
}

async function audioApp(page, { failFirst = false, fullItem = audioItem, itemDelayMs = 0,
  catalogItems = [audioItem], fullItems = {}, initialPath = '/title/podcast', startPlayer = true } = {}) {
  const saved = [], forbidden = [], errors = [], itemRequests = []; let streams = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/(?:hls|backdrop|api\/(?:sprites|metadata))\//.test(new URL(request.url()).pathname)) forbidden.push(request.url());
  });
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/audio-artwork/')) {
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="#38255d"/><circle cx="270" cy="100" r="150" fill="#7950b2"/><path d="M90 115h210v190H90z" fill="#eee1ff"/><path d="M200 115v190" stroke="#ab82dc" stroke-width="8"/></svg>' });
    }
    if (url.pathname === '/stream/podcast') {
      if (++streams === 1 && failFirst) return route.fulfill({ status: 404 });
      const body = wav(), range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || body.length - 1), body.length - 1);
        return route.fulfill({ status: 206, contentType: 'audio/wav', body: body.subarray(start, end + 1),
          headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` } });
      }
      return route.fulfill({ contentType: 'audio/wav', body, headers: { 'Accept-Ranges': 'bytes' } });
    }
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (url.pathname === '/api/health') body = { ready: true };
      else if (url.pathname === '/api/me') body = { loggedIn: true, role: 'user', profileId: 'test', name: 'Test' };
      else if (url.pathname === '/api/library') body = catalogItems;
      else if (url.pathname === '/api/library/sections') body = { ok: true, sections: [{ id: 'podcasts', label: 'Podcasts', type: 'custom-podcasts', mediaKind: 'audio', count: catalogItems.length, available: true }] };
      else if (url.pathname.startsWith('/api/item/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        itemRequests.push(id);
        if (itemDelayMs) await new Promise(resolve => setTimeout(resolve, itemDelayMs));
        body = fullItems[id] || fullItem;
      }
      else if (url.pathname === '/api/metadata/podcast') body = { found: false };
      else if (url.pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
      else if (url.pathname === '/api/notifications') body = { notifications: [] };
      else if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
      else if (url.pathname === '/api/progress') { saved.push(route.request().postDataJSON()); body = { ok: true }; }
      return route.fulfill({ json: body });
    }
    const file = url.pathname.startsWith('/assets/') ? path.join(dist, url.pathname) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto(`${origin}${initialPath}`);
  if (startPlayer) await page.getByRole('button', { name: /^Resume/ }).click();
  return { saved, forbidden, errors, itemRequests };
}

test('late book metadata does not override a manual rewind and pause', async ({ page }) => {
  const { errors } = await audioApp(page, { itemDelayMs: 3000,
    fullItem: { ...audioItem, audioMetadata: { title: 'Delayed metadata title', artist: 'Author' } } });
  const player = page.getByRole('dialog', { name: 'Audio player' }), audio = page.locator('audio');
  await expect.poll(() => audio.evaluate(el => !el.paused && el.currentTime >= 8)).toBe(true);
  await player.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await player.getByRole('slider', { name: 'Playback position' }).focus();
  await page.keyboard.press('Home');
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBe(0);
  await expect(player.getByRole('heading', { name: 'Delayed metadata title', exact: true })).toBeVisible();
  expect(await audio.evaluate(el => ({paused:el.paused,time:el.currentTime}))).toEqual({paused:true,time:0});
  await player.getByRole('button', { name: 'Close audio player' }).click();
  expect(errors).toEqual([]);
});

test('audio resumes, plays, seeks, changes speed and saves without video processing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { saved, forbidden, errors } = await audioApp(page);
  const player = page.getByRole('dialog', { name: 'Audio player' }), audio = page.locator('audio');
  await expect(player).toBeVisible();
  await expect.poll(() => audio.evaluate(el => !el.paused && el.currentTime >= 8 && el.readyState >= 3)).toBe(true);
  const started = await audio.evaluate(el => el.currentTime);
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeGreaterThan(started + 0.2);
  await player.getByLabel('Speed').selectOption('1.5');
  expect(await audio.evaluate(el => el.playbackRate)).toBe(1.5);
  await player.getByRole('button', { name: 'Forward 30 seconds' }).click();
  await expect.poll(() => saved.some(value => value.id === 'podcast' && value.currentTime >= 38 && value.profile === 'test')).toBe(true);
  await player.getByRole('button', { name: 'Back 15 seconds' }).click();
  await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeLessThan(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('audio-phone.png') });
  await player.getByRole('button', { name: 'Close audio player' }).click();
  await expect(player).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
});

test('audio failure gives a working retry and clears when playback succeeds', async ({ page }) => {
  const { forbidden, errors } = await audioApp(page, { failFirst: true });
  await expect(page.getByRole('alert')).toContainText(/unavailable|unsupported|Could not/);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate(el => !el.paused && el.readyState >= 3)).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
});

for (const width of [1280, 390]) {
  test(`audiobook controls show metadata and support keyboard, chapters and seeking at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { saved, forbidden, errors } = await audioApp(page, { fullItem: { ...audioItem, audioMetadata: {
      title: "Carl's Doomsday Scenario", artist: 'Matt Dinniman', album: 'Dungeon Crawler Carl, Book 2', duration: 60,
      coverUrl: '/audio-artwork/podcast', chapters: [
        { title: 'The Auction', start: 0, end: 20 }, { title: 'The Next Room', start: 20, end: 40 },
        { title: 'A New Floor', start: 40, end: 60 },
      ],
    } } });
    const player = page.getByRole('dialog', { name: 'Audio player' }), audio = page.locator('audio');
    await expect(player.getByRole('heading', { name: "Carl's Doomsday Scenario", exact: true })).toBeVisible();
    await expect(player.getByText('Matt Dinniman', { exact: true })).toBeVisible();
    await expect.poll(() => audio.evaluate(el => !el.paused && el.readyState >= 3)).toBe(true);
    expect(await audio.evaluate(el => el.controls)).toBe(false);
    await expect(player.locator('img')).toHaveAttribute('src', '/audio-artwork/podcast');
    await expect.poll(() => player.locator('img').evaluate(el => el.naturalWidth)).toBeGreaterThan(0);

    await player.getByRole('button', { name: 'Pause audio', exact: true }).click();
    await expect.poll(() => audio.evaluate(el => el.paused)).toBe(true);
    const position = player.getByRole('slider', { name: 'Playback position', exact: true });
    await position.focus(); await position.press('Home');
    await expect.poll(() => audio.evaluate(el => Math.floor(el.currentTime))).toBe(0);
    await position.press('ArrowRight');
    await expect.poll(() => audio.evaluate(el => el.currentTime)).toBeGreaterThan(0);
    // Range keys must seek rather than also firing global skip shortcuts.
    expect(await audio.evaluate(el => el.currentTime)).toBeLessThan(5);

    const chapter = player.getByLabel('Chapter', { exact: true });
    const chapterStyle = await chapter.evaluate(select => {
      const popup = getComputedStyle(select.querySelector('option'));
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => {
          const value = c / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
      };
      const values = [luminance(popup.color), luminance(popup.backgroundColor)].sort((a,b) => b-a);
      return { scheme:getComputedStyle(select).colorScheme, contrast:(values[0]+.05)/(values[1]+.05) };
    });
    expect(chapterStyle.scheme).toContain('dark');
    expect(chapterStyle.contrast).toBeGreaterThan(4.5);
    const nextLabel = (await chapter.locator('option').allTextContents()).find(text => text.includes('The Next Room'));
    await chapter.selectOption({ label: nextLabel });
    await expect.poll(() => audio.evaluate(el => Math.floor(el.currentTime))).toBe(20);
    await expect.poll(() => saved.some(value => value.currentTime === 20 && value.profile === 'test')).toBe(true);
    const volume = player.getByRole('slider', { name: 'Volume', exact: true });
    await volume.focus(); await volume.press('Home');
    await expect.poll(() => audio.evaluate(el => el.volume)).toBe(0);
    await volume.press('End');
    await expect.poll(() => audio.evaluate(el => el.volume)).toBe(1);

    await player.getByRole('button', { name: 'Play audio', exact: true }).click();
    await expect.poll(() => audio.evaluate(el => el.paused)).toBe(false);
    // Space on the Play/Pause button must produce exactly one toggle.
    await player.getByRole('button', { name: 'Pause audio', exact: true }).press('Space');
    await expect.poll(() => audio.evaluate(el => el.paused)).toBe(true);
    await player.getByRole('button', { name: 'Play audio', exact: true }).click();
    await player.getByLabel('Speed', { exact: true }).selectOption('1.5');
    expect(await audio.evaluate(el => el.playbackRate)).toBe(1.5);

    const close = player.getByRole('button', { name: 'Close audio player' });
    await close.focus(); await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press('Tab'); await expect(close).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`audiobook-${width}.png`), fullPage: true });
    await close.click();
    await expect(player).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Resume/ })).toBeFocused();
    expect(forbidden).toEqual([]); expect(errors).toEqual([]);
  });
}

for (const width of [1280, 390]) {
  test(`audio shelf shows authored titles, covers and a clean fallback at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const books = [
      { ...audioItem, title:'CarlsDoomsdayScenarioDungeonCrawlerCarlBook2', filename:'CarlsDoomsdayScenarioDungeonCrawlerCarlBook2_ep7.m4b' },
      { ...audioItem, id:'land', title:'TheLandFoundingALitRPGSaga', filename:'TheLandFoundingALitRPGSaga_ep7.m4b' },
      { ...audioItem, id:'fallback', title:'AnotherAudioBook2', filename:'AnotherAudioBook2_ep7.mp3', progress:null },
    ];
    const { itemRequests, forbidden, errors } = await audioApp(page, {
      catalogItems:books, initialPath:'/library/podcasts', startPlayer:false, itemDelayMs:100,
      fullItems:{
        podcast:{ ...books[0], audioMetadata:{ title:"Carl's Doomsday Scenario: Dungeon Crawler Carl, Book 2", artist:'Matt Dinniman', duration:41295, coverUrl:'/audio-artwork/podcast' } },
        land:{ ...books[1], audioMetadata:{ title:'The Land: Founding', artist:'Aleron Kong', duration:30000, coverUrl:'/audio-artwork/land' } },
        fallback:books[2],
      },
    });
    await expect(page.getByRole('heading', { name:'Podcasts', exact:true })).toBeVisible();
    const cards = page.locator('.grid .card.audio');
    await expect(cards).toHaveCount(3);
    const carl = cards.filter({ hasText:"Carl's Doomsday Scenario: Dungeon Crawler Carl, Book 2" });
    await expect(carl.locator('.audio-title')).toHaveText("Carl's Doomsday Scenario: Dungeon Crawler Carl, Book 2");
    await expect(carl.locator('.audio-author')).toHaveText('Matt Dinniman');
    await expect(carl.locator('img')).toHaveAttribute('src','/audio-artwork/podcast');
    await expect.poll(() => carl.locator('img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    const land = cards.filter({ hasText:'The Land: Founding' });
    await expect(land.locator('.audio-author')).toHaveText('Aleron Kong');
    await expect(land.locator('img')).toHaveAttribute('src','/audio-artwork/land');
    const fallback = cards.filter({ hasText:'Another Audio Book 2' });
    await expect(fallback.locator('.audio-placeholder')).toBeVisible();
    await expect(fallback.locator('.audio-title')).toHaveCount(1);
    await expect(fallback.locator('img')).toHaveCount(0);
    await page.getByRole('combobox', { name:'Sort', exact:true }).selectOption('title');
    await expect(cards.first().locator('.audio-title')).toHaveText('Another Audio Book 2');
    for (const card of await cards.all()) {
      const shape = await card.locator('.art').boundingBox();
      expect(Math.abs(shape.width - shape.height)).toBeLessThan(2);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:test.info().outputPath(`audio-shelf-${width}.png`), fullPage:true });
    await page.getByRole('link', { name:'Home', exact:true }).click();
    await page.getByRole('link', { name:'Podcasts', exact:true }).click();
    await expect(page.locator('.grid .card.audio img')).toHaveCount(2);
    expect(itemRequests.filter(id => id === 'podcast')).toHaveLength(1);
    expect(itemRequests.filter(id => id === 'land')).toHaveLength(1);
    expect(itemRequests.filter(id => id === 'fallback')).toHaveLength(1);
    expect(forbidden).toEqual([]); expect(errors).toEqual([]);
  });
}
