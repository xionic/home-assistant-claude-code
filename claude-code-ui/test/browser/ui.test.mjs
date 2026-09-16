/*
 * The UI driven in a real browser against the real server (with the scripted SDK
 * behind it). Everything else in this suite tests the wire; this tests what the
 * user actually sees.
 *
 * Chrome is not bundled — puppeteer-core drives whatever is installed. Set
 * CHROME_PATH to point at a specific binary. Without one, the suite skips rather
 * than failing, so `npm test` stays useful on a machine with no browser.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer } from '../helpers/server-harness.mjs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));

const scenario = {
  runs: [
    { steps: [{ text: 'The boiler fired because the schedule starts at 06:00.' }] },
    { steps: [{ tool: { name: 'Bash', input: { command: 'ls /config' }, id: 'b1' } }] },
    {
      steps: [
        { tool: { name: 'Read', input: { file_path: '/config/a.yaml' }, id: 'r1', output: 'a' } },
        { tool: { name: 'Read', input: { file_path: '/config/b.yaml' }, id: 'r2', output: 'b' } },
        { tool: { name: 'Read', input: { file_path: '/config/c.yaml' }, id: 'r3', output: 'c' } },
      ],
    },
    {
      steps: [{
        tool: {
          name: 'AskUserQuestion', id: 'q1',
          input: { questions: [{ header: 'Room', question: 'Which room?', options: [{ label: 'Hall' }, { label: 'Kitchen' }] }] },
        },
      }],
    },
  ],
};

describe('the chat UI', { skip: executablePath ? false : 'no Chrome found (set CHROME_PATH)' }, () => {
  let h, browser, page, consoleErrors;

  before(async () => {
    h = await startServer({ scenario });
    browser = await puppeteer.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('status-dot')?.classList.contains('connected'), { timeout: 5000 })
      .catch(() => {});   // the class name is incidental; the send below is the real check
  });

  after(async () => {
    if (browser) await browser.close();
    if (h) await h.stop();
  });

  async function send(text) {
    await page.type('#prompt-input', text);
    await page.click('#send-btn');
  }

  test('loads and connects with no console errors', async () => {
    assert.equal(await page.$eval('#prompt-input', (el) => el.tagName), 'TEXTAREA');
    assert.deepEqual(consoleErrors, []);
  });

  test('shows the message you sent and the reply that comes back', async () => {
    await send('why did the boiler fire?');
    await page.waitForSelector('.bubble-user', { timeout: 5000 });
    assert.match(await page.$eval('.bubble-user', (el) => el.textContent), /why did the boiler fire\?/);

    await page.waitForFunction(
      () => document.body.textContent.includes('the schedule starts at 06:00'), { timeout: 5000 });
  });

  test('asks before running a tool, and Allow lets it through', async () => {
    await send('list the config');
    await page.waitForSelector('#permission-overlay:not(.hidden)', { timeout: 5000 });
    assert.match(await page.$eval('#perm-tool-chip', (el) => el.textContent), /Bash/);
    assert.match(await page.$eval('#perm-input', (el) => el.textContent), /ls \/config/);

    await page.click('#perm-allow');
    await page.waitForSelector('#permission-overlay.hidden', { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelector('.tool-call-status.status-done') != null, { timeout: 5000 });
  });

  test('folds a run of tool calls as they arrive rather than after the turn', async () => {
    await page.select('#perm-mode', 'bypass');
    await send('read all three');
    await page.waitForFunction(
      () => document.querySelectorAll('.tool-call').length >= 4, { timeout: 5000 });
    const group = await page.evaluate(() => {
      const g = [...document.querySelectorAll('.tool-group')].at(-1);
      return {
        calls: g.querySelectorAll('.tool-call').length,
        headerVisible: !g.querySelector('.tool-group-header').classList.contains('hidden'),
        count: g.querySelector('.tool-group-count').textContent,
      };
    });
    assert.equal(group.calls, 3);
    assert.equal(group.headerVisible, true, 'a run of calls collapses to a single row');
    assert.match(group.count, /3/);
  });

  test('a question can be set aside and picked back up from the strip', async () => {
    await send('which room?');
    await page.waitForSelector('#dialog-overlay:not(.hidden)', { timeout: 5000 });

    // ✕ hides the card without answering — reading the chat is usually how you
    // work out what the answer should be.
    await page.click('#dialog-later');
    await page.waitForSelector('#dialog-overlay.hidden', { timeout: 5000 });
    await page.waitForSelector('#question-strip:not(.hidden)', { timeout: 5000 });

    await page.click('#question-strip-open');
    await page.waitForSelector('#dialog-overlay:not(.hidden)', { timeout: 5000 });

    await page.click('.dialog-option, #dialog-submit');
    await page.click('#dialog-submit').catch(() => {});
    await page.waitForFunction(
      () => document.body.textContent.includes('answered your question') ||
            document.querySelector('#dialog-overlay.hidden') != null, { timeout: 5000 });
  });

  test('find-in-chat counts and highlights matches', async () => {
    await page.click('#find-btn');
    await page.waitForSelector('#find-bar:not(.hidden)', { timeout: 5000 });
    await page.type('#find-input', 'boiler');
    await page.waitForFunction(
      () => !/^0\//.test(document.getElementById('find-count').textContent), { timeout: 5000 });
    assert.match(await page.$eval('#find-count', (el) => el.textContent), /^\d+\/\d+$/);
    await page.click('#find-close');
  });

  test('still has a clean console after all of that', () => {
    assert.deepEqual(consoleErrors, [], 'a no-build-step app has nothing else to catch these');
  });
});

describe('the layout on a phone', { skip: executablePath ? false : 'no Chrome found (set CHROME_PATH)' }, () => {
  let h, browser, page;
  before(async () => {
    h = await startServer({ scenario: { runs: [] } });
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
  });
  after(async () => {
    if (browser) await browser.close();
    if (h) await h.stop();
  });

  test('is a fixed frame with a single scroller, so a swipe cannot drag HA away', async () => {
    const overflow = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).overflow,
      body: getComputedStyle(document.body).overflow,
      messages: getComputedStyle(document.getElementById('messages')).overscrollBehavior,
    }));
    assert.equal(overflow.html, 'hidden');
    assert.equal(overflow.body, 'hidden');
    assert.match(overflow.messages, /contain/);
  });

  test('keeps the header and composer on screen', async () => {
    const boxes = await page.evaluate(() => {
      const h = document.querySelector('header') || document.querySelector('.header');
      const f = document.getElementById('input-form');
      return { header: h?.getBoundingClientRect().top, form: f?.getBoundingClientRect().bottom, vh: window.innerHeight };
    });
    assert.ok(boxes.header >= 0, 'header is not scrolled off the top');
    assert.ok(boxes.form <= boxes.vh + 1, 'composer is not below the fold');
  });
});

/*
 * The phone case that actually bit: not the app on its own, but the app inside
 * the Home Assistant ingress iframe on a mobile *browser*. HA sizes that iframe
 * against the large viewport, so while the URL bar is showing it hangs below
 * the bottom of the screen — and `100dvh` inside an iframe is the iframe, not
 * the screen, so the composer went with it. Nothing in the app could scroll it
 * back (that is what `overscroll-behavior` is for), and dragging HA's own
 * toolbar to reach it took our header off the top instead.
 *
 * The shell below is that geometry: a toolbar, an iframe sized to a viewport
 * 100px taller than the screen. Served through request interception so it is
 * same-origin with the app, exactly as real ingress is.
 */
describe('the layout inside the ingress iframe', { skip: executablePath ? false : 'no Chrome found (set CHROME_PATH)' }, () => {
  const SCREEN_W = 390, SCREEN_H = 740;
  const URL_BAR = 100;    // screen the URL bar is eating; HA's page ignores it
  const HA_TOOLBAR = 56;
  const SHELL_PATH = '/__test_ha_shell';

  let h, browser, page, consoleErrors;

  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ text: 'a\n'.repeat(200) }] }] } });
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.setViewport({ width: SCREEN_W, height: SCREEN_H, isMobile: true, hasTouch: true });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (!new URL(req.url()).pathname.startsWith(SHELL_PATH)) return req.continue();
      req.respond({
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html><html><head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            html, body { margin: 0; }
            body { height: ${SCREEN_H + URL_BAR}px; }
            .toolbar { height: ${HA_TOOLBAR}px; background: #03a9f4; }
            iframe { display: block; border: 0; width: 100%; height: ${SCREEN_H + URL_BAR - HA_TOOLBAR}px; }
          </style></head><body>
          <div class="toolbar" id="ha-toolbar"></div><iframe id="app-frame" src="/"></iframe>
          </body></html>`,
      });
    });

    await page.goto(h.baseUrl + SHELL_PATH, { waitUntil: 'networkidle0' });
    // Wait for the app itself, not for the fix — a broken layout must fail in
    // the assertions below, where the message says what is wrong, rather than
    // timing out here.
    await page.waitForFunction(
      () => document.getElementById('app-frame')?.contentDocument?.getElementById('input-form'),
      { timeout: 5000 });
    await settle();
  });

  after(async () => {
    if (browser) await browser.close();
    if (h) await h.stop();
  });

  /* Measuring is async — a frame for the rAF, and viewport.js re-reads once more
     at 250ms because a phone browser reports a stale height right after load. */
  const settle = () => new Promise((r) => setTimeout(r, 400));

  /** Where the app's header and composer sit on the *screen*, not in the iframe. */
  async function onScreen() {
    return page.evaluate(() => {
      const frame = document.getElementById('app-frame');
      const top = frame.getBoundingClientRect().top;
      const doc = frame.contentDocument;
      const box = (sel) => doc.querySelector(sel).getBoundingClientRect();
      return {
        headerTop: top + box('.header').top,
        composerBottom: top + box('.input-form').bottom,
        screen: window.innerHeight,
      };
    });
  }

  test('measures the visible band rather than trusting the iframe', async () => {
    const measured = await page.evaluate(() => {
      const root = document.getElementById('app-frame').contentDocument.documentElement;
      return {
        height: root.style.getPropertyValue('--app-height'),
        unmeasured: root.classList.contains('viewport-unmeasured'),
      };
    });
    assert.equal(measured.unmeasured, false, 'a same-origin parent is measurable');
    // The band is the screen minus HA's toolbar — not the iframe's own height.
    assert.equal(measured.height, `${SCREEN_H - HA_TOOLBAR}px`);
  });

  test('has the whole app on screen on load, composer included', async () => {
    const { headerTop, composerBottom, screen } = await onScreen();
    assert.ok(headerTop >= 0, `header is off the top (${headerTop})`);
    assert.ok(composerBottom <= screen + 1,
      `composer is below the fold (${composerBottom} > ${screen})`);
  });

  test('follows the page when HA scrolls under it, instead of going off the top', async () => {
    await page.evaluate((y) => window.scrollTo(0, y), URL_BAR);
    await new Promise((r) => setTimeout(r, 80));   // measured, but not yet put back

    const { headerTop, composerBottom, screen } = await onScreen();
    assert.ok(headerTop >= 0, `header is off the top after scrolling (${headerTop})`);
    assert.ok(composerBottom <= screen + 1,
      `composer is below the fold after scrolling (${composerBottom} > ${screen})`);
  });

  /*
   * Fitting to the visible band works just as well when the page above has been
   * scrolled away, which is the trap: HA's toolbar goes off the top, we re-fit
   * into the space it left, and the app looks perfectly normal with the menu
   * button gone and nothing in reach to scroll it back.
   */
  test("puts Home Assistant's own toolbar back after its page is scrolled away", async () => {
    await page.evaluate((y) => window.scrollTo(0, y), URL_BAR);
    await settle();

    const after = await page.evaluate(() => ({
      scrollY: window.scrollY,
      toolbarBottom: document.getElementById('ha-toolbar').getBoundingClientRect().bottom,
    }));
    assert.equal(after.scrollY, 0, 'HA\'s page was left scrolled');
    assert.ok(after.toolbarBottom > 0,
      `HA's menu button is off the top (toolbar ends at ${after.toolbarBottom})`);

    // …and the app still fits in what is left below the toolbar.
    const { headerTop, composerBottom, screen } = await onScreen();
    assert.ok(headerTop >= 0 && composerBottom <= screen + 1,
      `app spans ${headerTop}..${composerBottom} on a ${screen}px screen`);
  });

  test('leaves an ancestor alone when it has scrolling of its own to do', async () => {
    await page.evaluate(() => {
      const filler = document.createElement('div');
      filler.id = 'filler';
      filler.style.height = '1200px';
      document.body.appendChild(filler);
    });
    await page.evaluate((y) => window.scrollTo(0, y), URL_BAR);
    await settle();
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.equal(scrollY, URL_BAR, 'hijacked a page that had its own content to scroll');

    await page.evaluate(() => {
      document.getElementById('filler').remove();
      window.scrollTo(0, 0);
    });
    await settle();
  });

  test('keeps a dialog inside the visible band too', async () => {
    const fits = await page.evaluate(() => {
      const frame = document.getElementById('app-frame');
      const top = frame.getBoundingClientRect().top;
      const doc = frame.contentDocument;
      const overlay = doc.getElementById('permission-overlay');
      overlay.classList.remove('hidden');
      const box = overlay.getBoundingClientRect();
      const r = { top: top + box.top, bottom: top + box.bottom, screen: window.innerHeight };
      overlay.classList.add('hidden');
      return r;
    });
    assert.ok(fits.top >= 0 && fits.bottom <= fits.screen + 1,
      `overlay spans ${fits.top}..${fits.bottom} on a ${fits.screen}px screen`);
  });

  test('had a clean console throughout', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
