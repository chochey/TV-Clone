// The video player against the built UI: mocked API, and a real 60-second
// WebM made with ffmpeg so the <video> element actually plays, seeks and ends.
// Never talks to the media server.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'http://tvclone.test';
const clip = path.join(os.tmpdir(), 'tvclone-player-test-60s.webm');
const DURATION = 60;

test.beforeAll(() => {
  if (existsSync(clip)) return;
  execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(DURATION), '-c:v', 'libvpx-vp9', '-b:v', '120k', '-g', '48', '-deadline', 'realtime', '-cpu-used', '8',
    '-c:a', 'libopus', '-b:a', '32k', clip]);
});

const film = { id: 'film', title: 'Test film', year: 2001, type: 'movie', streamMode: 'direct', codec: 'vp9', addedAt: 1, subtitles: [], progress: {} };
const episode = n => ({ id: `ep${n}`, title: `Episode ${n}`, showName: 'Test show', type: 'show', mediaKind: 'show',
  epInfo: { season: 1, episode: n }, streamMode: 'direct', codec: 'vp9', addedAt: 1, subtitles: [], progress: {} });
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nHello there\n';

async function setup(page, { items = [film, episode(1), episode(2)], detail = {}, segments = {} } = {}) {
  const calls = { progress: [], streams: 0 };
  const clipBytes = await fs.readFile(clip);
  await page.route('**/*', route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const requested = new URL(route.request().url()).pathname;
    const file = requested.startsWith('/assets/') ? path.join(dist, requested) : path.join(dist, 'index.html');
    let body = await fs.readFile(file);
    if (file.endsWith('index.html')) body = body.toString().replace(/<link[^>]+https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '');
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    if (pathname === '/api/progress') { calls.progress.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    let body = {};
    if (pathname === '/api/health') body = { ready: true };
    else if (pathname === '/api/me') body = { loggedIn: true, role: 'admin', profileId: 'test', name: 'Test' };
    else if (pathname === '/api/library') body = items;
    else if (pathname === '/api/library/sections') body = { ok: true, sections: [] };
    else if (pathname.startsWith('/api/item/')) { const id = pathname.split('/').at(-1); body = { ...items.find(i => i.id === id), ...(detail[id] || {}) }; }
    else if (pathname.startsWith('/api/skip-segments/')) body = segments[pathname.split('/').at(-1)] || {};
    else if (pathname === '/api/dismissed') body = { continueWatching: {}, recentlyAdded: {} };
    else if (pathname === '/api/requests') body = { requests: [] };
    else if (pathname === '/api/notifications') body = { notifications: [] };
    else if (pathname.startsWith('/api/metadata/')) body = { found: false };
    else if (pathname.startsWith('/api/sprites/')) body = { status: 'ready', totalSheets: 0 };
    else if (pathname === '/api/now-watching') body = [];
    return route.fulfill({ json: body });
  });
  await page.route('**/backdrop/**', route => route.fulfill({ status: 404 }));
  await page.route('**/poster/**', route => route.fulfill({ status: 404 }));
  await page.route('**/subtitle/**', route => route.fulfill({ body: vtt, contentType: 'text/vtt' }));
  await page.route('**/stream/**', route => {
    calls.streams++;
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : clipBytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, body: clipBytes.subarray(start, end + 1),
      headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${clipBytes.length}` } : {}) } });
  });
  return calls;
}

const player = page => page.locator('.player');
const videoTime = page => page.evaluate(() => document.querySelector('.player video').currentTime);
const videoState = page => page.evaluate(() => { const v = document.querySelector('.player video'); return { paused: v.paused, rate: v.playbackRate, muted: v.muted, volume: v.volume }; });

async function openFilm(page, opts) {
  const calls = await setup(page, opts);
  await page.goto(`${origin}/title/film`);
  await page.locator('.actions').getByRole('button', { name: /^(Play|Resume)/ }).first().click();
  await expect.poll(() => videoTime(page), { timeout: 10000 }).toBeGreaterThan(0.5);
  return calls;
}
async function openEpisode(page, opts) {
  const calls = await setup(page, opts);
  await page.goto(`${origin}/title/ep1`);
  await page.locator('.actions').getByRole('button', { name: /Play|Resume/ }).first().click();
  await expect.poll(() => videoTime(page), { timeout: 10000 }).toBeGreaterThan(0.5);
  return calls;
}
async function seekVideo(page, t) {
  await page.evaluate(t => { document.querySelector('.player video').currentTime = t; }, t);
}

test('a film plays, shows its title and clock, and pauses and resumes from the button and Space', async ({ page }) => {
  const calls = await openFilm(page);
  await expect(player(page).locator('.ptitle .t')).toHaveText('Test film');
  await expect(player(page).locator('.ptitle .s')).toHaveText('2001');
  await expect(player(page).locator('.time')).toHaveText(/^0:0\d \/ 1:00$/);
  await expect(player(page).locator('.spinner')).toHaveCount(0);
  await player(page).getByRole('button', { name: 'Pause' }).click();
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await expect(player(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect.poll(() => calls.progress.length).toBeGreaterThan(0);
  expect(calls.progress.at(-1)).toMatchObject({ id: 'film', profile: 'test' });
  expect(calls.progress.at(-1).duration).toBeCloseTo(DURATION, 0);
  await page.keyboard.press(' ');
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);
});

test('keys seek by ten seconds, change volume and mute, and leave browser shortcuts alone', async ({ page }) => {
  await openFilm(page);
  const before = await videoTime(page);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => videoTime(page)).toBeGreaterThan(before + 8);
  const ahead = await videoTime(page);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => videoTime(page)).toBeLessThan(ahead - 8);
  await page.keyboard.press('ArrowDown');
  await expect(player(page).locator('.pct')).toHaveText('95%');
  await page.keyboard.press('ArrowUp');
  await expect(player(page).locator('.pct')).toHaveText('100%');
  await page.keyboard.press('m');
  await expect.poll(async () => (await videoState(page)).muted).toBe(true);
  await expect(player(page).getByRole('button', { name: 'Unmute' })).toBeVisible();
  await page.keyboard.press('m');
  const t = await videoTime(page);
  await page.keyboard.press('Control+ArrowRight');
  expect(await videoTime(page)).toBeLessThan(t + 5);
});

test('volume above 100 shows as a boost and is remembered (the slider shows on wide screens)', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openFilm(page);
  await player(page).getByRole('slider', { name: /Volume/ }).evaluate(el => { el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(player(page).locator('.pct')).toHaveText('120%');
  await expect(player(page).locator('.pct')).toHaveClass(/boost/);
  expect((await videoState(page)).volume).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('playerVolumePct'))).toBe('120');
});

test('speed menu sets the rate, lights the button and is remembered; Escape closes the menu first', async ({ page }) => {
  await openFilm(page);
  await player(page).getByRole('button', { name: 'Playback speed' }).click();
  await expect(player(page).locator('.menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(player(page).locator('.menu')).toHaveCount(0);
  await expect(player(page)).toHaveCount(1, { timeout: 500 });
  await player(page).getByRole('button', { name: 'Playback speed' }).click();
  await player(page).locator('.menu').getByRole('button', { name: '1.5×' }).click();
  await expect.poll(async () => (await videoState(page)).rate).toBe(1.5);
  await expect(player(page).locator('.speedbtn span')).toHaveText('1.5×');
  await expect(player(page).locator('.speedbtn span')).toHaveClass(/on/);
  expect(await page.evaluate(() => localStorage.getItem('v2Speed'))).toBe('1.5');
});

test('choosing subtitles shows the cue and Off hides it', async ({ page }) => {
  await openFilm(page, { detail: { film: { subtitles: [{ url: '/subtitle/s1', label: 'English' }] } } });
  await player(page).getByRole('button', { name: 'Subtitles' }).click();
  await player(page).locator('.menu').getByRole('button', { name: 'English' }).click();
  await expect(player(page).locator('.cue')).toHaveText('Hello there');
  await expect(player(page).getByRole('button', { name: 'Subtitles' })).toHaveClass(/on/);
  await player(page).getByRole('button', { name: 'Subtitles' }).click();
  await player(page).locator('.menu').getByRole('button', { name: 'Off' }).click();
  await expect(player(page).locator('.cue')).toHaveCount(0);
});

test('an open menu closes on a click on the video without pausing', async ({ page }) => {
  await openFilm(page);
  await player(page).getByRole('button', { name: 'Playback speed' }).click();
  await player(page).locator('video').click({ position: { x: 200, y: 200 } });
  await expect(player(page).locator('.menu')).toHaveCount(0);
  expect((await videoState(page)).paused).toBe(false);
  await player(page).locator('video').click({ position: { x: 200, y: 200 } });
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
});

test('Skip Intro appears inside the intro and jumps past it', async ({ page }) => {
  await openFilm(page, { segments: { film: { intro: { start: 0, end: 20 } } } });
  const skip = player(page).getByRole('button', { name: 'Skip Intro' });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect.poll(() => videoTime(page)).toBeGreaterThanOrEqual(19.5);
  await expect(skip).toHaveCount(0);
});

test('clicking the scrubber seeks there', async ({ page }) => {
  await openFilm(page);
  const bar = await player(page).locator('.scrub').boundingBox();
  await page.mouse.move(bar.x + bar.width * 0.75, bar.y + bar.height / 2);
  await expect(player(page).locator('.hovertime')).toHaveText(/^0:4\d$/);
  await page.mouse.down(); await page.mouse.up();
  await expect.poll(() => videoTime(page)).toBeGreaterThan(40);
});

test('a saved position resumes, and closing saves where you stopped', async ({ page }) => {
  const calls = await openFilm(page, { items: [{ ...film, progress: { currentTime: 25, duration: 60, percent: 41 } }, episode(1), episode(2)] });
  expect(await videoTime(page)).toBeGreaterThan(24);
  await player(page).getByRole('button', { name: 'Close player' }).click();
  await expect(player(page)).toHaveCount(0);
  expect(calls.progress.at(-1).currentTime).toBeGreaterThan(24);
});

test('controls hide while playing and come back when the mouse moves', async ({ page }) => {
  await openFilm(page);
  await expect(player(page)).toHaveClass(/idle/, { timeout: 6000 });
  await page.mouse.move(300, 300); await page.mouse.move(310, 310);
  await expect(player(page)).not.toHaveClass(/idle/);
});

test('an episode offers next, counts down near the end, can be cancelled, and Play now moves on', async ({ page }) => {
  const calls = await openEpisode(page);
  await expect(player(page).locator('.ptitle .t')).toHaveText('Test show');
  await expect(player(page).getByRole('button', { name: /Next episode S1 · E2/ })).toBeVisible();
  await expect(player(page).getByRole('button', { name: /Previous episode/ })).toHaveCount(0);
  await seekVideo(page, 45);
  const card = player(page).locator('.upnext');
  await expect(card).toContainText(/Up next in \d+s/);
  await expect(card).toContainText('S1 · E2');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(card).toHaveCount(0);
  await player(page).getByRole('button', { name: /Next episode S1 · E2/ }).click();
  await expect(player(page).locator('.ptitle .s')).toContainText('S1 · E2');
  await expect(player(page).getByRole('button', { name: /Previous episode S1 · E1/ })).toBeVisible();
  await expect.poll(() => videoTime(page), { timeout: 10000 }).toBeGreaterThan(0.5);
  expect(calls.progress.some(p => p.id === 'ep1')).toBe(true);
});

test('the up-next countdown advances on its own and the last episode says so', async ({ page }) => {
  const calls = await openEpisode(page);
  await seekVideo(page, 55);
  await expect(player(page).locator('.ptitle .s')).toContainText('S1 · E2', { timeout: 15000 });
  expect(calls.progress.find(p => p.id === 'ep1' && p.currentTime === p.duration), 'the finished episode is saved as ended').toBeTruthy();
  await expect.poll(() => videoTime(page), { timeout: 10000 }).toBeGreaterThan(0.5);
  await seekVideo(page, 45);
  const card = player(page).locator('.upnext');
  await expect(card).toContainText("That's the last one");
  await card.getByRole('button', { name: 'Keep watching' }).click();
  await expect(card).toHaveCount(0);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`the controls fit the screen at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openEpisode(page, { detail: { ep1: { subtitles: [{ url: '/subtitle/s1', label: 'English' }] } } });
    await player(page).getByRole('button', { name: 'Pause' }).click();
    for (const element of await player(page).locator('.controls button, .controls .time').all()) {
      if (!(await element.isVisible())) continue;
      const box = await element.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    await page.screenshot({ path: test.info().outputPath(`player-${viewport.width}.png`) });
  });
}
