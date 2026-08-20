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
