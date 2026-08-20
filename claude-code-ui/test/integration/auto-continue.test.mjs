/*
 * Auto-continue on a usage limit.
 *
 * The subtle part is that a rejection lies about itself: the SDK emits
 * rate_limit_event(status:'rejected'), then a `result` claiming success, and
 * *then* the generator throws. Only the first of those three is trustworthy, and
 * treating the throw as a fresh failure used to drop the session id — which read
 * to the user as the whole conversation vanishing.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, userLine } from '../helpers/server-harness.mjs';

const RESET_AT = Math.floor(Date.now() / 1000) + 3600;

/** The exact three-part sequence a real five-hour rejection produces. */
function limitRun({ resetsAt = RESET_AT, rateLimitType = 'five_hour' } = {}) {
  return {
    steps: [{ emit: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType, resetsAt } } }],
    throwAfterResult: "Claude Code returned an error result: You've hit your session limit · resets 1am (Europe/London)",
  };
}

const seeded = {
  sessions: { 'sess-live': [userLine('a question from before the limit')] },
  data: { 'active-session.json': { sessionId: 'sess-live' } },
};

describe('a five-hour limit with auto-continue on', () => {
  let h;
  before(async () => {
    h = await startServer({
      ...seeded,
      data: { ...seeded.data, 'auto-continue.json': { enabled: true, pending: null, offer: null } },
      scenario: { runs: [limitRun()] },
    });
  });
  after(async () => { await h.stop(); });

  test('notes where the chat stopped and schedules the resume', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'a long job', permissionMode: 'bypass' });

    const notice = await c.waitFor('limit_notice');
    assert.equal(notice.scheduled, true);
    assert.equal(notice.supported, true);
    assert.equal(notice.resetsAt, RESET_AT);

    const pending = await c.waitFor('auto_continue_pending');
    assert.equal(pending.attempts, 1);
    assert.equal(h.readData('auto-continue.json').pending.resetsAt, RESET_AT,
      'persisted, so it survives a restart');
  });

  test('does not report the throw as an error, and keeps the session to resume from', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    assert.equal(c.all('error').length, 0);
    assert.equal(h.readData('active-session.json').sessionId, 'sess-live',
      'a limited session is not a stale one');
  });
});

describe('a five-hour limit with auto-continue off', () => {
  let h;
  before(async () => {
    h = await startServer({ ...seeded, scenario: { runs: [limitRun()] } });
  });
  after(async () => { await h.stop(); });

  test('offers to pick this run up rather than only the next one', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'a long job', permissionMode: 'bypass' });

    const notice = await c.waitFor('limit_notice');
    assert.equal(notice.scheduled, false);

    const offer = await c.waitFor('limit_offer');
    assert.equal(offer.resetsAt, RESET_AT);
    assert.equal(h.readData('auto-continue.json').offer.sessionId, 'sess-live');
  });

  test('and turning the toggle on afterwards schedules that very offer', async () => {
    const c = await h.connect();
    await c.waitFor('limit_offer');
    c.send({ type: 'set_auto_continue', enabled: true });

    const pending = await c.waitFor('auto_continue_pending');
    assert.equal(pending.resetsAt, RESET_AT);
    await c.waitFor('limit_offer_cleared');
  });
});

describe('a seven-day limit', () => {
  let h;
  before(async () => {
    h = await startServer({
      ...seeded,
      data: { ...seeded.data, 'auto-continue.json': { enabled: true, pending: null, offer: null } },
      scenario: { runs: [limitRun({ rateLimitType: 'seven_day' })] },
    });
  });
  after(async () => { await h.stop(); });

  test('is surfaced but never scheduled — nobody wants an unattended week-long wait', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'a long job', permissionMode: 'bypass' });
    const rl = await c.waitFor('rate_limit');
    assert.equal(rl.rateLimitType, 'seven_day');
    await c.waitFor('sessions');
    assert.equal(c.all('limit_notice').length, 0);
    assert.equal(h.readData('auto-continue.json').pending, null);
  });
});

describe('a pending resume across a restart', () => {
  let first;
  after(async () => { if (first) await first.stop(); });

  test('is re-armed on boot', async () => {
    first = await startServer({
      ...seeded,
      data: {
        ...seeded.data,
        'auto-continue.json': {
          enabled: true, offer: null,
          pending: { resetsAt: RESET_AT, rateLimitType: 'five_hour', model: null, effort: null, permissionMode: 'bypass', attempts: 1 },
        },
      },
    });
    const c = await first.connect();
    const pending = await c.waitFor('auto_continue_pending');
    assert.equal(pending.resetsAt, RESET_AT);
    await first.waitForLog('auto-continue: five_hour limit hit; resuming at');
  });
});

describe('a pending resume that is no longer eligible', () => {
  let h;
  before(async () => {
    h = await startServer({
      subscription: false,   // API-key auth: no reset time to schedule against
      data: {
        'auto-continue.json': {
          enabled: true, offer: null,
          pending: { resetsAt: RESET_AT, rateLimitType: 'five_hour', permissionMode: 'bypass', attempts: 1 },
        },
      },
    });
  });
  after(async () => { await h.stop(); });

  test('is dropped on boot instead of firing into nothing', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    assert.equal(h.readData('auto-continue.json').pending, null);
    assert.equal((await c.waitFor('config')).autoContinueSupported, false);
  });
});

describe('a resume that is immediately limited again', () => {
  let h;
  before(async () => {
    h = await startServer({
      ...seeded,
      data: {
        ...seeded.data,
        'auto-continue.json': {
          enabled: true, offer: null,
          // Already at the cap, and due 20s ago, so it fires the moment we boot.
          pending: {
            resetsAt: Math.floor(Date.now() / 1000) - 20, rateLimitType: 'five_hour',
            model: null, effort: null, permissionMode: 'bypass', attempts: 3,
          },
        },
      },
      scenario: { runs: [limitRun()] },
    });
  });
  after(async () => { await h.stop(); });

  test('gives up rather than retrying forever', async () => {
    await h.waitForLog('still limited after 3 attempts — giving up', { timeout: 10000 });
    assert.equal(h.readData('auto-continue.json').pending, null);
  });
});

describe('a fresh prompt while a resume is scheduled', () => {
  let h;
  before(async () => {
    h = await startServer({
      ...seeded,
      data: {
        ...seeded.data,
        'auto-continue.json': {
          enabled: true, offer: null,
          pending: { resetsAt: RESET_AT, rateLimitType: 'five_hour', model: null, effort: null, permissionMode: 'bypass', attempts: 1 },
        },
      },
      scenario: { runs: [{ steps: [{ text: 'carrying on' }] }] },
    });
  });
  after(async () => { await h.stop(); });

  test('supersedes it — the user has taken over', async () => {
    const c = await h.connect();
    await c.waitFor('auto_continue_pending');
    c.send({ type: 'prompt', text: 'never mind, do this instead', permissionMode: 'bypass' });
    const cancelled = await c.waitFor('auto_continue_cancelled');
    assert.equal(cancelled.reason, 'superseded-by-prompt');
    assert.equal(h.readData('auto-continue.json').pending, null);
  });
});

describe('the auto-continue toggle', () => {
  let h;
  before(async () => { h = await startServer(seeded); });
  after(async () => { await h.stop(); });

  test('is server-owned, so a resume can fire with no browser open', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'set_auto_continue', enabled: true });
    const state = await c.waitFor('auto_continue_state');
    assert.equal(state.enabled, true);
    assert.equal(h.readData('auto-continue.json').enabled, true);

    await c.close();
    const c2 = await h.connect();
    assert.equal((await c2.waitFor('config')).autoContinue, true, 'and it is still on for the next tab');
  });
});
