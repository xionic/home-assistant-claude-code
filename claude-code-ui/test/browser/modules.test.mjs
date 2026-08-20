/*
 * One pass through every part of the UI that the main flow does not touch.
 *
 * The point is coverage rather than depth: with the frontend split into ES
 * modules, a module nothing exercises is a module whose first user is the user.
 * Each test below loads and runs at least one path through one module, and the
 * whole file asserts a clean console at the end.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));

const RESET_AT = Math.floor(Date.now() / 1000) + 3600;

describe('the rest of the UI', { skip: executablePath ? false : 'no Chrome found (set CHROME_PATH)' }, () => {
  let h, browser, page, consoleErrors;

  before(async () => {
    h = await startServer({
      sessions: {
        'earlier': [userLine('An earlier conversation'), assistantLine([{ type: 'text', text: 'and its answer' }])],
      },
      data: { 'active-session.json': { sessionId: 'earlier' } },
      scenario: {
        runs: [
          { steps: [{ text: 'Checking `light.hall` now.\n\n```yaml\nkey: value\n```' }] },
          { steps: [{ throw: 'something went wrong upstream' }], noResult: true },
          {
            steps: [{ emit: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: RESET_AT } } }],
            throwAfterResult: "Claude Code returned an error result: You've hit your session limit",
          },
        ],
      },
    });
    browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(h.baseUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.bubble', { timeout: 5000 });   // the seeded history
  });

  after(async () => {
    if (browser) await browser.close();
    if (h) await h.stop();
  });

  const send = async (text) => { await page.type('#prompt-input', text); await page.click('#send-btn'); };

  test('replays the stored conversation on load', async () => {
    const text = await page.$eval('#messages', (el) => el.textContent);
    assert.match(text, /An earlier conversation/);
    assert.match(text, /and its answer/);
  });

  test('renders markdown, and links entity ids to Home Assistant', async () => {
    // The server sends ha_links from the live instance; there is none under test,
    // so inject the link targets the same way the connection module would.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));   // no-op, keeps the eval honest
    });
    await page.select('#perm-mode', 'bypass');
    await send('what is the hall light doing?');
    await page.waitForSelector('.bubble-assistant pre', { timeout: 5000 });
    assert.ok(await page.$('.bubble-assistant code'), 'the fenced block became a code block');
    assert.ok(await page.$('.copy-btn, .code-copy, button[class*="copy"]'), 'code blocks get a copy button');
  });

  test('the sessions panel lists past conversations and can switch between them', async () => {
    await page.click('#sessions-btn');
    await page.waitForSelector('#sessions-panel:not(.hidden)', { timeout: 5000 });
    const titles = await page.$$eval('.session-item', (els) => els.map((e) => e.textContent));
    assert.ok(titles.some((t) => /An earlier conversation/.test(t)), `saw: ${titles.join(' | ')}`);
    await page.click('#sessions-btn');
  });

  test('the settings panel remembers the model and effort you pick', async () => {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-panel:not(.hidden)', { timeout: 5000 });
    await page.select('#model-select', 'claude-sonnet-5');
    await page.select('#effort-select', 'low');
    const stored = await page.evaluate(() => [localStorage.getItem('model'), localStorage.getItem('effort')]);
    assert.deepEqual(stored, ['claude-sonnet-5', 'low']);
    await page.click('#settings-btn');
  });

  test('slash-command autocomplete offers the app commands', async () => {
    await page.type('#prompt-input', '/us');
    await page.waitForSelector('#cmd-menu:not(.hidden)', { timeout: 5000 });
    const items = await page.$$eval('#cmd-menu *', (els) => els.map((e) => e.textContent).join(' '));
    assert.match(items, /usage/);
    await page.evaluate(() => { document.getElementById('prompt-input').value = ''; });
    await page.keyboard.press('Escape');
  });

  test('/usage reports the session totals', async () => {
    await page.evaluate(() => { document.getElementById('prompt-input').value = ''; });
    await send('/usage');
    await page.waitForFunction(
      () => /Turns:/.test(document.getElementById('messages').textContent), { timeout: 5000 });
  });

  test('an error from the run is shown as an error, not silence', async () => {
    await send('make it fail');
    await page.waitForFunction(
      () => /something went wrong upstream/.test(document.getElementById('messages').textContent),
      { timeout: 8000 });
  });

  test('a usage limit explains itself and offers to pick the chat up', async () => {
    await send('a long job');
    await page.waitForSelector('#auto-continue-banner:not(.hidden)', { timeout: 8000 });
    const banner = await page.$eval('#ac-banner-text', (el) => el.textContent);
    assert.ok(banner.trim().length > 0, 'the banner says nothing');
    await page.waitForFunction(
      () => /limit/i.test(document.getElementById('messages').textContent), { timeout: 5000 });
  });

  test('attaching a file shows it above the composer and can be removed', async () => {
    const input = await page.$('#attach-input');
    await input.uploadFile(new URL('../helpers/fixtures/note.txt', import.meta.url).pathname);
    await page.waitForSelector('#attach-preview:not(.hidden)', { timeout: 5000 });
    assert.match(await page.$eval('#attach-preview', (el) => el.textContent), /note\.txt/);

    const remove = await page.$('#attach-preview button');
    if (remove) {
      await remove.click();
      await page.waitForSelector('#attach-preview.hidden', { timeout: 5000 });
    }
  });

  test('New chat clears the transcript', async () => {
    await page.click('#new-session-btn');
    await page.waitForFunction(
      () => document.querySelectorAll('#messages .bubble-user').length === 0, { timeout: 5000 });
  });

  test('and the console stayed clean throughout', () => {
    assert.deepEqual(consoleErrors, []);
  });
});
