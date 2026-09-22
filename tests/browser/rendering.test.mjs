import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Start the static server first. An installed Chrome can be selected with BROWSER_EXECUTABLE.
let browser;
let page;
const errors = [];
const ready = async () => {
  await page.waitForFunction(() => window.__app && !__app.calculating);
  await page.locator('#loading').waitFor({ state: 'hidden' });
};
const settled = async () => {
  await ready();
  await page.waitForTimeout(350);
};
const counters = () => page.evaluate(() => ({ ...__app.renderStats }));

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:8000');
  await settled();
});
after(async () => { await browser?.close(); });

test('dragging moves cached layers without repainting labels or moving the input surface', async () => {
  const before = await counters();
  await page.mouse.move(950, 440);
  await page.mouse.down();
  await page.mouse.move(1050, 480, { steps: 25 });
  const during = await counters();
  assert.equal(during.featureDraws, before.featureDraws);
  assert.ok(during.draws > before.draws + 5);
  assert.equal(await page.locator('#tooltip').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => {
    const layers = [...document.querySelectorAll('.map-layer')];
    return { aligned: layers[0].style.transform === layers[1].style.transform,
      input: document.elementFromPoint(900, 400).id,
      inputLeft: document.querySelector('#map').getBoundingClientRect().left };
  }), { aligned: true, input: 'map', inputLeft: 0 });
  await page.mouse.up();
  await page.locator('#zoomReset').click();
  await settled();
});

test('hover routes update without invalidating the label cache', async () => {
  const before = await counters();
  for (const name of ['Greenwich Observatory', 'Wembley Stadium', 'Trafalgar Square']) {
    const point = await page.evaluate((name) => __app.screenOf(__app.nodes.findIndex((n) => n.name === name)), name);
    await page.mouse.move(...point);
    await page.locator('#tooltip').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#tooltip').innerText()).includes(name));
  }
  assert.equal((await counters()).featureDraws, before.featureDraws);
  await page.mouse.move(1400, 10);
});

test('new calculations and display options refresh cached markers', async () => {
  let before = await counters();
  await page.locator('.mode').filter({ hasText: 'Car' }).click();
  await settled();
  assert.ok((await counters()).featureDraws > before.featureDraws);
  await page.locator('.mode').filter({ hasText: 'Car' }).click();
  await settled();
  before = await counters();
  await page.locator('#stations').uncheck();
  await settled();
  assert.ok((await counters()).featureDraws > before.featureDraws);
  assert.equal(await page.evaluate(() => __app.state.showStations), false);
  await page.locator('#stations').check();
  await settled();
});

test('zoom, cache-edge drags, resizing and stretching keep the layers in sync', async () => {
  for (let i = 0; i < 3; i++) {
    const k = await page.evaluate(() => __app.transform.k);
    await page.locator('#zoomIn').click();
    await page.waitForFunction((k) => Math.abs(__app.transform.k - k * 1.6) < 0.001, k);
    await settled();
  }
  const before = await counters();
  await page.mouse.move(900, 450);
  await page.mouse.down();
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(1400, 750, { steps: 35 });
    await page.mouse.move(400, 200, { steps: 55 });
  }
  await page.mouse.up();
  await settled();
  assert.ok((await counters()).scrolls > before.scrolls);
  assert.equal(await page.locator('.map-layer').count(), 2);
  await page.locator('#zoomReset').click();
  await settled();
  await page.locator('#more summary').click();
  await page.locator('#morph').press('End');
  await settled();
  assert.equal(await page.evaluate(() => __app.state.morph), 1);
  await page.locator('#morph').press('Home');
  await settled();
  await page.setViewportSize({ width: 390, height: 844 });
  await settled();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.equal(await page.locator('#collapse').getAttribute('aria-expanded'), 'false');
  const idle = (await counters()).draws;
  await page.waitForTimeout(400);
  assert.equal((await counters()).draws, idle);
  assert.deepEqual(errors, []);
});
