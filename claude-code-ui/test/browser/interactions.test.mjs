/*
 * The interaction paths — the things a user does that no wire assertion can
 * stand in for: setting a question aside and coming back to it, paging through
 * a multi-question dialog, opening a folded run of tool calls, stepping through
 * find hits, and not being yanked to the bottom while reading.
 *
 * These are deliberately deeper than modules.test.mjs, which only proves each
 * module loads and runs at all.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';
import { startFakeHa, TOKEN } from '../helpers/fake-ha.mjs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
const skip = executablePath ? false : 'no Chrome found (set CHROME_PATH)';

const bash = (id, cmd) => ({ tool: { name: 'Bash', input: { command: cmd }, id, output: 'ok' } });

async function launch(harness) {
  const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(harness.baseUrl, { waitUntil: 'networkidle0' });
  return { browser, page, errors };
}

describe('setting things aside', { skip }, () => {
  let h, browser, page, errors;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [
          { steps: [bash('b1', 'rm -rf /config/x')] },
          {
            steps: [{
              tool: {
                name: 'AskUserQuestion', id: 'q1',
                input: { questions: [
                  { header: 'Room', question: 'Which room?', options: [{ label: 'Hall' }, { label: 'Kitchen' }] },
                  { header: 'Time', question: 'When?', options: [{ label: 'Morning' }, { label: 'Evening' }] },
                ] },
              },
            }],
          },
        ],
      },
    });
    ({ browser, page, errors } = await launch(h));
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  const send = async (t) => { await page.type('#prompt-input', t); await page.click('#send-btn'); };

  test('a permission card can be closed without answering, and recovered', async () => {
    await send('delete something');
    await page.waitForSelector('#permission-overlay:not(.hidden)', { timeout: 5000 });

    await page.click('#perm-later');
    await page.waitForSelector('#permission-overlay.hidden', { timeout: 5000 });
    await page.waitForSelector('#question-strip:not(.hidden)', { timeout: 5000 });

    // Nothing was decided: the turn is still paused on that prompt.
    assert.equal(h.records('tool_decision').length, 0);

    await page.click('#question-strip-open');
    await page.waitForSelector('#permission-overlay:not(.hidden)', { timeout: 5000 });
    await page.click('#perm-deny');
    await page.waitForSelector('#permission-overlay.hidden', { timeout: 5000 });
    assert.equal(h.records('tool_decision').at(-1).outcome.behavior, 'deny');
  });

  test('a two-question dialog pages forward and back before submitting', async () => {
    await send('which room and when?');
    await page.waitForSelector('#dialog-overlay:not(.hidden)', { timeout: 5000 });

    const progress = () => page.$eval('#dialog-progress', (el) => el.textContent.trim());
    const submitLabel = () => page.$eval('#dialog-submit', (el) => el.textContent.trim());
    // Every page is in the DOM; only one is visible. Clicking the first
    // `.dialog-option` outright would keep hitting page one's.
    const pickOnVisiblePage = () => page.evaluate(() => {
      const page_ = [...document.querySelectorAll('#dialog-body > *')].find((p) => !p.classList.contains('hidden'));
      page_.querySelector('.dialog-option').click();
    });

    assert.equal(await progress(), '1/2', 'starts on the first of two');
    assert.equal(await submitLabel(), 'Next', 'the button says what it will do');

    await pickOnVisiblePage();
    await page.waitForFunction(
      () => !document.getElementById('dialog-submit').disabled, { timeout: 5000 });
    await page.click('#dialog-submit');

    await page.waitForFunction(
      () => /^2\/2$/.test(document.getElementById('dialog-progress').textContent.trim()), { timeout: 5000 });
    assert.equal(await submitLabel(), 'Submit', 'the last page submits rather than advancing');

    await page.click('#dialog-back');
    await page.waitForFunction(
      () => /^1\/2$/.test(document.getElementById('dialog-progress').textContent.trim()), { timeout: 5000 });
    const stillChecked = await page.$$eval('.dialog-option input', (els) => els.some((e) => e.checked));
    assert.equal(stillChecked, true, 'going back must not discard the answer already given');

    await page.click('#dialog-submit');
    await page.waitForFunction(
      () => /^2\/2$/.test(document.getElementById('dialog-progress').textContent.trim()), { timeout: 5000 });
    await pickOnVisiblePage();
    await page.waitForFunction(
      () => !document.getElementById('dialog-submit').disabled, { timeout: 5000 });
    await page.click('#dialog-submit');

    await page.waitForFunction(
      () => /answered your question/.test(document.getElementById('messages').textContent), { timeout: 5000 });
    const answer = h.records('tool_decision').at(-1).outcome.message;
    assert.match(answer, /- Room: /);
    assert.match(answer, /- Time: /);
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('a folded run of tool calls', { skip }, () => {
  let h, browser, page, errors;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{ steps: [bash('a', 'one'), bash('b', 'two'), bash('c', 'three')] }],
      },
    });
    ({ browser, page, errors } = await launch(h));
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  test('opens when you click it, and stays open as more calls arrive', async () => {
    await page.select('#perm-mode', 'bypass');
    await page.type('#prompt-input', 'run three things');
    await page.click('#send-btn');

    await page.waitForFunction(
      () => document.querySelectorAll('.tool-call').length >= 3, { timeout: 5000 });
    const group = await page.$('.tool-group');
    assert.equal(await group.evaluate((g) => g.classList.contains('collapsed')), true);

    await (await page.$('.tool-group-header')).click();
    assert.equal(await group.evaluate((g) => g.classList.contains('collapsed')), false);
    assert.equal(await group.evaluate((g) => g._st.touched), true,
      'once opened by hand it must not fold itself back up under you');
  });

  test('an individual call expands to show its input', async () => {
    const call = await page.$('.tool-call');
    await (await call.$('.tool-call-header')).click();
    assert.equal(await call.evaluate((c) => c.classList.contains('expanded')), true);
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('find in chat', { skip }, () => {
  let h, browser, page, errors;
  before(async () => {
    h = await startServer({
      sessions: {
        's': [
          userLine('the boiler again'),
          assistantLine([{ type: 'text', text: 'the boiler fired at 3am' }]),
          userLine('and the boiler after that?'),
        ],
      },
      data: { 'active-session.json': { sessionId: 's' } },
    });
    ({ browser, page, errors } = await launch(h));
    await page.waitForSelector('.bubble', { timeout: 5000 });
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  test('counts every hit and steps through them', async () => {
    await page.click('#find-btn');
    await page.type('#find-input', 'boiler');
    await page.waitForFunction(
      () => /^1\/3$/.test(document.getElementById('find-count').textContent), { timeout: 5000 });

    await page.click('#find-next');
    assert.equal(await page.$eval('#find-count', (e) => e.textContent), '2/3');
    await page.click('#find-next');
    assert.equal(await page.$eval('#find-count', (e) => e.textContent), '3/3');
    await page.click('#find-next');
    assert.equal(await page.$eval('#find-count', (e) => e.textContent), '1/3', 'wraps round');

    await page.click('#find-prev');
    assert.equal(await page.$eval('#find-count', (e) => e.textContent), '3/3', 'and back the other way');
  });

  test('marks the current hit distinctly from the rest', async () => {
    const marks = await page.$$eval('mark, .find-hit', (els) => els.length);
    assert.ok(marks >= 3, `expected the matches to be highlighted, saw ${marks}`);
  });

  test('closing find removes the highlighting', async () => {
    await page.click('#find-close');
    await page.waitForSelector('#find-bar.hidden', { timeout: 5000 });
    assert.equal(await page.$eval('#find-count', (e) => e.textContent), '0/0');
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('entity ids in a reply', { skip }, () => {
  let h, ha, browser, page, errors;
  before(async () => {
    ha = await startFakeHa({
      rest: {
        'core/api/states': [
          { entity_id: 'light.hall', state: 'on', attributes: {} },
          { entity_id: 'automation.morning', state: 'on', attributes: { id: '1699' } },
        ],
      },
    });
    h = await startServer({
      env: { SUPERVISOR_TOKEN: TOKEN, HA_SUPERVISOR_URL: ha.supervisorUrl },
      scenario: {
        runs: [{ steps: [{ text: 'I turned on light.hall via automation.morning, see configuration.yaml' }] }],
      },
    });
    ({ browser, page, errors } = await launch(h));
  });
  after(async () => {
    if (browser) await browser.close();
    if (h) await h.stop();
    if (ha) await ha.close();
  });

  test('only real entities become links — not anything that merely looks like one', async () => {
    await page.select('#perm-mode', 'bypass');
    await page.type('#prompt-input', 'turn on the hall light');
    await page.click('#send-btn');
    await page.waitForSelector('.ha-entity-link', { timeout: 8000 });

    const linked = await page.$$eval('.ha-entity-link', (els) => els.map((e) => e.textContent));
    assert.ok(linked.includes('light.hall'));
    assert.ok(linked.includes('automation.morning'));
    assert.equal(linked.includes('configuration.yaml'), false,
      'a regex alone would happily link a filename');
  });

  test('an automation links to its editor id, not its entity id', async () => {
    const href = await page.$$eval('.ha-entity-link',
      (els) => els.find((e) => e.textContent === 'automation.morning')?.getAttribute('href'));
    assert.match(href || '', /1699/, 'the entity_id does not work in the automation editor URL');
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('reading while a reply arrives', { skip }, () => {
  let h, browser, page, errors;
  before(async () => {
    const long = Array.from({ length: 40 }, (_, i) => userLine(`message number ${i}`));
    h = await startServer({
      sessions: { 's': long },
      data: { 'active-session.json': { sessionId: 's' } },
      scenario: { runs: [{ steps: [{ sleep: 300 }, { text: 'a new reply arriving' }] }] },
    });
    ({ browser, page, errors } = await launch(h));
    await page.waitForSelector('.bubble', { timeout: 5000 });
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  test('a long history opens at the bottom', async () => {
    const atBottom = await page.$eval('#messages',
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 100);
    assert.equal(atBottom, true);
  });

  test('scrolling up to read is not undone by incoming output', async () => {
    await page.$eval('#messages', (el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await new Promise((r) => setTimeout(r, 100));

    await page.select('#perm-mode', 'bypass');
    await page.type('#prompt-input', 'say something');
    await page.evaluate(() => {
      // Send without the composer's own scroll-to-bottom, which is correct
      // behaviour when *you* send but would mask what this test is checking.
      document.getElementById('messages').scrollTop = 0;
    });
    await page.click('#send-btn');
    await page.waitForFunction(
      () => /a new reply arriving/.test(document.getElementById('messages').textContent), { timeout: 8000 });

    // Sending re-pins deliberately, so assert the transcript grew rather than
    // that the position never moved — the regression this guards is a *reply*
    // to someone else's tab yanking you down, which sending does not.
    const count = await page.$$eval('.bubble', (els) => els.length);
    assert.ok(count > 40);
  });

  test('the ↑/↓ arrows step between your own messages', async () => {
    await page.$eval('#messages', (el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await new Promise((r) => setTimeout(r, 100));
    const before = await page.$eval('#messages', (el) => el.scrollTop);
    await page.evaluate(() => document.getElementById('prompt-prev').click());
    await new Promise((r) => setTimeout(r, 400));
    const after = await page.$eval('#messages', (el) => el.scrollTop);
    assert.notEqual(after, before, 'the up arrow did not move the viewport');
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('a draft left in the box', { skip }, () => {
  let h, browser, page, errors;
  before(async () => {
    h = await startServer({});
    ({ browser, page, errors } = await launch(h));
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  test('survives navigating away and back', async () => {
    await page.type('#prompt-input', 'half a thought about the boiler');
    await page.waitForFunction(
      () => localStorage.getItem('draft')?.includes('half a thought'), { timeout: 5000 });

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => document.getElementById('prompt-input').value.includes('half a thought'), { timeout: 5000 });
    assert.equal(await page.$eval('#send-btn', (el) => el.disabled), false,
      'the send button must come back enabled for a restored draft');
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('leaving a chat while Claude is still working', { skip }, () => {
  let h, browser, page, errors, spy;
  before(async () => {
    h = await startServer({
      // One long run, so the whole block executes with a turn in flight.
      scenario: { runs: [{ steps: [{ text: 'thinking about it' }, { sleep: 30000 }] }] },
      sessions: {
        'aaaaaaaa-0000-0000-0000-000000000001': [userLine('what is the hall light doing')],
        'bbbbbbbb-0000-0000-0000-000000000002': [userLine('the boiler again')],
      },
    });
    // A second socket, so "nothing was sent" is asserted against the server's
    // own broadcasts rather than against the DOM of the tab under test.
    spy = await h.connect();
    await spy.waitFor('history');
    ({ browser, page, errors } = await launch(h));

    await page.type('#prompt-input', 'take your time');
    await page.click('#send-btn');
    await page.waitForFunction(
      () => document.getElementById('send-btn').classList.contains('stop'), { timeout: 5000 });
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  // Opening the panel asks the server for a fresh list, which re-renders it —
  // so settle before clicking, or the click lands on a node already replaced.
  const openPanel = async () => {
    await page.click('#sessions-btn');
    await page.waitForSelector('#sessions-panel:not(.hidden) .session-item', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 250));
  };

  test('clicking another chat asks first, and sends nothing yet', async () => {
    const before = spy.all('history').length;
    await openPanel();
    await page.click('.session-item');
    await page.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });

    assert.match(await page.$eval('#confirm-title', (el) => el.textContent), /still working/i);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(spy.all('history').length, before,
      'the switch was sent before the user had answered');
  });

  test('staying here leaves the panel open and the turn running', async () => {
    await page.click('#confirm-no');
    await page.waitForSelector('#confirm-overlay.hidden', { timeout: 5000 });

    assert.equal(await page.$eval('#sessions-panel', (el) => el.classList.contains('hidden')), false,
      'cancelling closed the panel, so the user cannot pick a different chat');
    assert.equal(await page.$eval('#send-btn', (el) => el.classList.contains('stop')), true,
      'the turn stopped anyway');
  });

  test('Escape and a click on the backdrop both mean stay', async () => {
    const before = spy.all('history').length;

    await page.click('.session-item');
    await page.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#confirm-overlay.hidden', { timeout: 5000 });

    await page.click('.session-item');
    await page.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });
    // The backdrop is the overlay itself; click a corner well clear of the card.
    await page.mouse.click(8, 8);
    await page.waitForSelector('#confirm-overlay.hidden', { timeout: 5000 });

    assert.equal(spy.all('history').length, before,
      'dismissing the warning switched chats anyway');
  });

  test('the new-chat button asks too, and /new cannot get round it', async () => {
    await page.click('#new-session-btn');
    await page.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });
    assert.match(await page.$eval('#confirm-yes', (el) => el.textContent), /new chat/i);
    await page.click('#confirm-no');
    await page.waitForSelector('#confirm-overlay.hidden', { timeout: 5000 });

    const before = spy.all('cleared').length;
    await page.type('#prompt-input', '/new');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });
    await page.click('#confirm-no');
    await page.waitForSelector('#confirm-overlay.hidden', { timeout: 5000 });
    assert.equal(spy.all('cleared').length, before, '/new started a new chat without asking');
  });

  test('going ahead switches, and the panel closes', async () => {
    const before = spy.all('history').length;
    await openPanel();
    await page.click('.session-item');
    await page.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });
    await page.click('#confirm-yes');

    await spy.waitFor((m) => m.type === 'history' && spy.all('history').length > before);
    await page.waitForSelector('#sessions-panel.hidden', { timeout: 5000 });
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});

describe('leaving a chat when nothing is running', { skip }, () => {
  let h, browser, page, errors, spy;
  before(async () => {
    h = await startServer({
      sessions: { 'cccccccc-0000-0000-0000-000000000003': [userLine('an old conversation')] },
    });
    spy = await h.connect();
    await spy.waitFor('history');
    ({ browser, page, errors } = await launch(h));
  });
  after(async () => { if (browser) await browser.close(); if (h) await h.stop(); });

  test('switches straight away — the guard must not become a nag', async () => {
    const before = spy.all('history').length;
    await page.click('#sessions-btn');
    await page.waitForSelector('#sessions-panel:not(.hidden) .session-item', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 250));
    await page.click('.session-item');

    await spy.waitFor((m) => m.type === 'history' && spy.all('history').length > before);
    assert.equal(await page.$eval('#confirm-overlay', (el) => el.classList.contains('hidden')), true,
      'an idle app asked before switching');
  });

  test('and a new chat starts without asking', async () => {
    const before = spy.all('cleared').length;
    await page.click('#new-session-btn');
    await spy.waitFor((m) => m.type === 'cleared' && spy.all('cleared').length > before);
    assert.equal(await page.$eval('#confirm-overlay', (el) => el.classList.contains('hidden')), true);
  });

  test('deleting a conversation asks, in the app rather than the browser', async () => {
    await page.click('#sessions-btn');
    await page.waitForSelector('#sessions-panel:not(.hidden) .session-item', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 250));
    await page.click('.session-del');
    await page.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });
    assert.match(await page.$eval('#confirm-title', (el) => el.textContent), /delete/i);

    await page.click('#confirm-yes');
    await page.waitForFunction(
      () => document.querySelectorAll('#sessions-list .session-item').length === 0, { timeout: 5000 });
  });

  test('with a clean console', () => assert.deepEqual(errors, []));
});
