import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    playwright: { type: 'string' },
    browser: { type: 'string', default: 'chrome' },
    url: { type: 'string', default: 'http://127.0.0.1:4321' },
    artifacts: { type: 'string', default: '.checks' },
    'skip-fixtures': { type: 'boolean', default: false },
  },
});
const require = createRequire(import.meta.url);
const { chromium } = require(values.playwright ?? 'playwright');
const artifactDir = path.resolve(values.artifacts);
fs.mkdirSync(artifactDir, { recursive: true });

function testAudio() {
  const samples = 44100 * 10;
  const body = Buffer.alloc(44 + samples * 2);
  body.write('RIFF', 0);
  body.writeUInt32LE(body.length - 8, 4);
  body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(44100, 24);
  body.writeUInt32LE(88200, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write('data', 36);
  body.writeUInt32LE(samples * 2, 40);
  return body;
}

const browser = await chromium.launch({ channel: values.browser, headless: true });
let passed = 0;
const audioBody = testAudio();

async function check(name, work) {
  await work();
  passed++;
  console.log(`PASS ${name}`);
}

async function openPage(context, route) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  await page.route('**/audio/**', (request) => request.fulfill({ contentType: 'audio/wav', body: audioBody }));
  await page.goto(new URL(route, values.url).href);
  await page.waitForFunction(() => !document.querySelector('astro-island[ssr]'));
  return { page, errors };
}

async function assertFits(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('.app-header__logo')).every((image) => image.complete && image.naturalWidth > 0)), true);
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
    const { page, errors } = await openPage(context, '/');
    await check(`navigation and theme at ${viewport.width}px`, async () => {
      await assertFits(page);
      await page.locator('#theme-toggle').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#theme-toggle').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#theme-toggle').getAttribute('aria-expanded'), 'false');
      await page.locator('#drawer-open').click();
      assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'), 'false');
      assert.equal(await page.locator('#drawer-close').evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator('#drawer a').last().evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#drawer-open').evaluate((element) => element === document.activeElement), true);
      assert.equal(await page.locator('#drawer').evaluate((element) => element.inert), true);
    });
    await check(`playback, pause, resume and fixed controls at ${viewport.width}px`, async () => {
      await page.locator('.sound-btn:not(.sound-stack)').first().click();
      await page.waitForFunction(() => document.querySelector('.bottom-sheet__status')?.textContent === '播放中');
      await page.waitForFunction(() => parseFloat(document.querySelector('.bottom-sheet__progress')?.style.width) > 0);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.bottom-sheet__status')?.textContent === '已暂停');
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.bottom-sheet__status')?.textContent === '播放中');
      await page.waitForTimeout(350);
      const before = await page.locator('.bottom-sheet').boundingBox();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(150);
      const after = await page.locator('.bottom-sheet').boundingBox();
      assert.ok(Math.abs(before.y - after.y) < 2);
      assert.ok(after.y >= 0 && after.y + after.height <= viewport.height);
      const fab = await page.locator('.fab.main').boundingBox();
      assert.ok(after.y + after.height < fab.y || after.x + after.width < fab.x);
      await assertFits(page);
      await page.screenshot({ path: path.join(artifactDir, `playing-${viewport.width}.png`) });
      await page.getByRole('button', { name: '停止', exact: true }).click();
      assert.equal(await page.locator('.bottom-sheet').count(), 0);
    });
    await check(`search and group navigation at ${viewport.width}px`, async () => {
      await page.locator('.search-box input').fill('no-such-sound-12345');
      assert.equal(await page.locator('.no-result').count(), 1);
      await page.getByRole('button', { name: '清除', exact: true }).click();
      const name = await page.locator('.tab').first().textContent();
      await page.locator('.tab').first().click();
      await page.locator('.tab').first().click();
      assert.equal(await page.getByRole('button', { name, exact: false }).last().getAttribute('aria-expanded'), 'true');
    });
    assert.deepEqual(errors, []);
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const { page, errors } = await openPage(context, '/request/');
  await check('song sharing keeps /request/ and author grouping removes duplicates', async () => {
    await page.locator('.sound-btn').first().click();
    await page.getByRole('button', { name: '分享', exact: true }).click();
    const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(link.pathname, '/request/');
    assert.ok(link.searchParams.get('btn'));
    const normalCount = await page.locator('.sound-btn').count();
    await page.getByRole('button', { name: '原唱作者', exact: true }).click();
    const artistCount = await page.locator('.sound-btn').count();
    assert.ok(artistCount > 0 && artistCount <= normalCount);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.goto(link.href);
    await page.waitForSelector('.bottom-sheet');
    await assertFits(page);
    await page.screenshot({ path: path.join(artifactDir, 'songs-desktop.png') });
  });
  await check('easter egg unlock, cross-page switch and reload reset', async () => {
    await page.goto(new URL('/', values.url).href);
    for (let index = 0; index < 15; index++) await page.locator('#theme-toggle').click();
    await page.goto(new URL('/about/', values.url).href);
    assert.equal(await page.locator('#past-card').isVisible(), true);
    await page.locator('#past-toggle').check();
    await page.goto(new URL('/', values.url).href);
    await page.waitForSelector('#group-forgotten');
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('astro-island[ssr]'));
    assert.equal(await page.locator('#group-forgotten').count(), 0);
  });

  if (!values['skip-fixtures']) {
    await check('empty collections, identical names and tooltips render safely', async () => {
      await page.goto(new URL('/about/', values.url).href);
      await page.evaluate(async () => {
        const source = await (await fetch('/src/components/SoundBoard.tsx')).text();
        const webImport = source.match(/from\s+["']([^"']*solid-js_web[^"']*)["']/);
        if (!webImport) throw new Error('Fixture checks need the Astro dev server.');
        const { render } = await import(webImport[1]);
        const { SoundBoard } = await import('/src/components/SoundBoard.tsx');
        const mount = document.createElement('div');
        document.querySelector('main').replaceChildren(mount);
        window.disposeBoardFixture = render(() => SoundBoard({
          enableSecret: false,
          groups: [{
            groupName: 'fixture',
            title: 'Fixture',
            voices: [
              { path: 'fixture/a.mp3', zh: 'Same name', info: { title: 'Title', thumb: '/thumbs/placeholder.svg' } },
              { path: 'fixture/b.mp3', zh: 'Same name' },
            ],
            stacks: [{ title: 'Empty collection', voices: [] }],
          }],
        }), mount);
      });
      assert.equal(await page.getByRole('button', { name: 'Empty collection（暂无音频）' }).isDisabled(), true);
      await page.getByRole('button', { name: 'Same name', exact: true }).first().click();
      await page.waitForFunction(() => document.querySelector('.bottom-sheet__status')?.textContent === '播放中');
      assert.equal(await page.locator('.sound-btn.playing').count(), 1);
      await page.getByRole('button', { name: 'Same name', exact: true }).last().click();
      assert.equal(await page.locator('.sound-btn.playing').count(), 1);
      await page.getByRole('button', { name: 'Same name', exact: true }).first().focus();
      await page.waitForTimeout(150);
      const bounds = await page.locator('.sound-tip').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.y + bounds.height <= 900);
      await page.screenshot({ path: path.join(artifactDir, 'fixture-empty-collection.png') });
      await page.evaluate(() => window.disposeBoardFixture());
      assert.equal(await page.locator('.sound-tip').count(), 0);
      assert.equal(await page.locator('.bottom-sheet').count(), 0);
    });
    for (const width of [1440, 375]) {
      await check(`OSS audio, image-host links and configured media bases at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(new URL('/about/', values.url).href);
        const directAudio = 'https://oss.example.test/signed/a%20b.mp3?Signature=A%2Fb%2B&Expires=123';
        const directImage = 'https://images.example.test/cover.svg?x-oss-process=image/resize,w_320&token=A%2B';
        const requests = [];
        await page.route('https://oss.example.test/**', (route) => {
          requests.push(route.request().url());
          return route.fulfill({ contentType: 'audio/wav', body: audioBody });
        });
        await page.route('https://images.example.test/**', (route) => {
          requests.push(route.request().url());
          return route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#339966"/></svg>',
          });
        });
        await page.evaluate(async ({ directAudio, directImage }) => {
          const source = await (await fetch('/src/components/SoundBoard.tsx')).text();
          const webImport = source.match(/from\s+["']([^"']*solid-js_web[^"']*)["']/);
          const { render } = await import(webImport[1]);
          const { SoundBoard } = await import('/src/components/SoundBoard.tsx');
          const { media } = await import('/src/data/media.ts');
          const original = { ...media };
          media.audioBaseUrl = 'https://oss.example.test/audio';
          media.imageBaseUrl = 'https://images.example.test/public';
          const mount = document.createElement('div');
          document.querySelector('main').replaceChildren(mount);
          const dispose = render(() => SoundBoard({
            enableSecret: false,
            groups: [{
              groupName: 'remote', title: 'Remote',
              voices: [
                { path: directAudio, zh: 'Direct', info: { title: 'Direct image', thumb: directImage } },
                { path: 'songs/曲 #1%.mp3', zh: 'Base', info: { title: 'Base image', thumb: '/thumbs/封面 #1%.svg' } },
              ],
            }],
          }), mount);
          window.disposeBoardFixture = () => { dispose(); Object.assign(media, original); };
        }, { directAudio, directImage });
        const encodedAudio = 'https://oss.example.test/audio/songs/%E6%9B%B2%20%231%25.mp3';
        const encodedImage = 'https://images.example.test/public/thumbs/%E5%B0%81%E9%9D%A2%20%231%25.svg';
        for (const [name, audio, image] of [['Direct', directAudio, directImage], ['Base', encodedAudio, encodedImage]]) {
          await page.getByRole('button', { name, exact: true }).click();
          await page.waitForFunction(() => document.querySelector('.bottom-sheet__status')?.textContent === '播放中');
          await page.locator('.search-box input').focus();
          await page.getByRole('button', { name, exact: true }).focus();
          await page.waitForFunction(() => {
            const image = document.querySelector('.sound-tip__thumb');
            return image?.complete && image.naturalWidth > 0;
          });
          assert.equal(await page.locator('.sound-tip__thumb').getAttribute('src'), image);
          assert.ok(requests.includes(audio));
          assert.ok(requests.includes(image));
          await assertFits(page);
          await page.waitForFunction(() => getComputedStyle(document.querySelector('.sound-tip')).opacity === '1');
          const bounds = await page.locator('.sound-tip').boundingBox();
          assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900);
          await page.screenshot({ path: path.join(artifactDir, `media-${name.toLowerCase()}-${width}.png`) });
          await page.getByRole('button', { name: '停止', exact: true }).click();
        }
        await page.evaluate(() => window.disposeBoardFixture());
        await page.unroute('https://oss.example.test/**');
        await page.unroute('https://images.example.test/**');
      });
    }
  }
  await check('missing files report failure and clear playback', async () => {
    await page.goto(new URL('/', values.url).href);
    await page.unroute('**/audio/**');
    await page.route('**/audio/**', (request) => request.fulfill({ status: 404, body: 'Not found' }));
    await page.locator('.sound-btn:not(.sound-stack)').first().click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('播放失败'));
    assert.equal(await page.locator('.bottom-sheet').count(), 0);
  });
  assert.deepEqual(errors, []);
  await context.close();

  const privateContext = await browser.newContext();
  await privateContext.addInitScript(() => {
    for (const key of ['sessionStorage', 'localStorage']) {
      Object.defineProperty(window, key, { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
    }
  });
  await check('navigation still works when browser storage is blocked', async () => {
    const { page, errors } = await openPage(privateContext, '/about/');
    await page.locator('#drawer-open').click();
    await page.keyboard.press('Escape');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(errors, []);
  });
  await privateContext.close();
  console.log(`Browser checks passed: ${passed}`);
} finally {
  await browser.close();
}
