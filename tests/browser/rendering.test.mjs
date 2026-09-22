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
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => !__app.navigating);
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

test('dragging across controls releases cleanly and does not select an origin', async () => {
  const origin = await page.evaluate(() => ({ ...__app.state.origin }));
  await page.mouse.move(960, 460);
  await page.mouse.down();
  await page.mouse.move(120, 150, { steps: 20 });
  await page.mouse.up();
  const released = await page.evaluate(() => ({ ...__app.transform }));
  await page.mouse.move(1000, 500, { steps: 10 });
  assert.deepEqual(await page.evaluate(() => ({ ...__app.transform })), released);
  assert.deepEqual(await page.evaluate(() => ({ ...__app.state.origin })), origin);
  assert.equal(await page.evaluate(() => __app.navigating), false);
  await page.locator('#zoomReset').click();
  await settled();
});

test('interrupted drags recover after blur, cancellation, capture loss and a missed release', async () => {
  for (const interruption of ['blur', 'cancel', 'capture', 'release']) {
    await page.evaluate(() => {
      document.querySelector('#map').addEventListener('pointerdown', (e) => { window.testPointer = e.pointerId; }, { once: true });
    });
    await page.mouse.move(940, 450);
    await page.mouse.down();
    await page.mouse.move(1020, 480, { steps: 5 });
    const before = await page.evaluate(() => ({ ...__app.transform }));
    // Inject browser/OS interruptions that normal mouse automation cannot generate.
    await page.evaluate((kind) => {
      const map = document.querySelector('#map');
      if (kind === 'blur') window.dispatchEvent(new Event('blur'));
      if (kind === 'cancel') map.dispatchEvent(new PointerEvent('pointercancel', { pointerId: testPointer }));
      if (kind === 'capture') map.releasePointerCapture(testPointer);
      if (kind === 'release') map.dispatchEvent(new PointerEvent('pointermove', { pointerId: testPointer, pointerType: 'mouse', buttons: 0, clientX: 1020, clientY: 480 }));
    }, interruption);
    await page.mouse.move(1100, 520, { steps: 5 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => ({ ...__app.transform })), before, interruption);
    assert.equal(await page.evaluate(() => __app.navigating), false, interruption);
    assert.notEqual(await page.locator('#map').evaluate(el => el.style.cursor), 'grabbing');
    // The next real gesture still works, and releasing it leaves no stuck state.
    await page.mouse.move(940, 450);
    await page.mouse.down();
    await page.mouse.move(990, 475, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => ({ ...__app.transform }));
    assert.ok(Math.abs(after.x - before.x - 50) < 0.01, interruption);
    assert.ok(Math.abs(after.y - before.y - 25) < 0.01, interruption);
    await page.locator('#zoomReset').click();
    await settled();
  }
});

test('continuous zoom reuses detail and fills newly exposed map until the gesture ends', async () => {
  await page.mouse.move(940, 450);
  for (const delta of [-80, 80]) {
    const before = await counters();
    const initial = await page.evaluate(() => ({ ...__app.transform }));
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(20);
    }
    const active = await counters();
    assert.equal(active.layerDraws, before.layerDraws, 'no full map redraw during zoom');
    assert.equal(active.featureDraws, before.featureDraws, 'no label redraw during zoom');
    assert.equal(await page.locator('.map-preview').isVisible(), true);
    const current = await page.evaluate(() => ({ ...__app.transform }));
    assert.ok(delta < 0 ? current.k > initial.k : current.k < initial.k);
    assert.ok(Math.abs((940 - current.x) / current.k - (940 - initial.x) / initial.k) < 0.001, JSON.stringify({ initial, current }));
    await settled();
    assert.ok((await counters()).layerDraws > before.layerDraws, 'detail restored after zoom');
    assert.equal(await page.locator('.map-preview').isVisible(), false);
  }
  await page.locator('#zoomReset').click();
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

test('touch pinch transitions into a pan, cancels cleanly and still allows a tap', async () => {
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', (error) => errors.push(error.message));
    await touchPage.goto(process.env.TEST_URL || 'http://127.0.0.1:8000');
    await touchPage.waitForFunction(() => window.__app && !__app.calculating);
    await touchPage.waitForTimeout(600);
    const cdp = await touchContext.newCDPSession(touchPage);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
    const initial = await touchPage.evaluate(() => ({ transform: { ...__app.transform }, origin: { ...__app.state.origin } }));
    await touch('touchStart', [[1, 150, 400], [2, 250, 400]]);
    await touch('touchMove', [[1, 110, 400], [2, 290, 400]]);
    await touchPage.waitForFunction(k => Math.abs(__app.transform.k / k - 1.8) < 0.001, initial.transform.k);
    const pinched = await touchPage.evaluate(() => ({ ...__app.transform }));
    assert.ok(Math.abs(pinched.k / initial.transform.k - 1.8) < 0.001);
    await touch('touchEnd', [[2, 290, 400]]);
    await touch('touchMove', [[1, 140, 440]]);
    await touchPage.waitForFunction(x => Math.abs(__app.transform.x - x - 30) < 0.001, pinched.x);
    const panned = await touchPage.evaluate(() => ({ ...__app.transform }));
    assert.ok(Math.abs(panned.x - pinched.x - 30) < 0.001);
    assert.ok(Math.abs(panned.y - pinched.y - 40) < 0.001);
    await touch('touchCancel', []);
    await touchPage.waitForFunction(() => !__app.navigating);
    assert.equal(await touchPage.evaluate(() => __app.navigating), false);
    assert.deepEqual(await touchPage.evaluate(() => ({ ...__app.state.origin })), initial.origin);
    await touchPage.locator('#zoomReset').tap();
    await touchPage.waitForTimeout(600);
    const point = await touchPage.evaluate(() => __app.screenOf(__app.nodes.findIndex(n => n.name === 'Greenwich Observatory')));
    await touchPage.touchscreen.tap(...point);
    await touchPage.waitForFunction(() => !__app.calculating && __app.state.origin.name === 'Greenwich Observatory');
    assert.deepEqual(errors, []);
  } finally { await touchContext.close(); }
});
