/*
 * Who gets into /diag.
 *
 * These routes are not a debugging curiosity: /diag/query and /diag/feed run a
 * real turn with every tool auto-approved, and /diag/grep hands back transcripts.
 * They were reachable by anything that could open a socket to the app's port, so
 * the cases below are the security boundary — each one is a way in that must stay
 * shut, and they are written to fail loudly if the guard is ever loosened.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, userLine } from '../helpers/server-harness.mjs';
import { startFakeCore } from '../helpers/fake-core.mjs';

const ADMIN = 'admin-token';
const HOUSEMATE = 'non-admin-token';

/** Every route, not a sample: the guard is mounted on the group, and this is what
 *  would catch someone re-registering one of them outside it. */
const ROUTES = [
  '/diag', '/diag/config', '/diag/conv', '/diag/sesslist', '/diag/grep?q=x',
  '/diag/autocontinue', '/diag/sessions', '/diag/query?q=hi', '/diag/feed?q=hi',
];

describe('the /diag guard', () => {
  let h, core;

  before(async () => {
    core = await startFakeCore({
      tokens: {
        [ADMIN]: { isAdmin: true, name: 'Nick' },
        [HOUSEMATE]: { isAdmin: false, name: 'Housemate' },
      },
    });
    h = await startServer({
      env: { DEBUG_MODE: 'true', HA_CORE_WS_URL: core.wsUrl },
      sessions: { sess: [userLine('a question')] },
      data: { 'active-session.json': { sessionId: 'sess' } },
    });
  });
  after(async () => { await h.stop(); await core.stop(); });

  test('refuses every route with no token at all', async () => {
    for (const route of ROUTES) {
      const res = await h.get(route);
      assert.equal(res.status, 401, `${route} answered ${res.status} unauthenticated`);
      assert.equal(res.json?.error, 'unauthorized');
    }
  });

  test('refuses a token Home Assistant does not recognise', async () => {
    const res = await h.get('/diag', { token: 'not-a-real-token' });
    assert.equal(res.status, 401);
  });

  test('refuses a malformed Authorization header', async () => {
    for (const header of ['', 'Bearer', 'Basic abc', ADMIN]) {
      const res = await h.get('/diag', { rawAuth: header });
      assert.equal(res.status, 401, `header ${JSON.stringify(header)} got in`);
    }
  });

  test('refuses a valid token that is not an admin, and says so distinctly', async () => {
    const res = await h.get('/diag', { token: HOUSEMATE });
    assert.equal(res.status, 403, 'a non-admin HA user must not reach /diag');
    assert.equal(res.json?.error, 'forbidden');
  });

  test('admits an admin', async () => {
    const res = await h.get('/diag', { token: ADMIN });
    assert.equal(res.status, 200);
    assert.ok('ws_ping' in res.json.tests);
  });

  test('does not run a turn for a refused caller', async () => {
    const before = h.records('query').length;
    assert.equal((await h.get('/diag/query?q=hi')).status, 401);
    assert.equal((await h.get('/diag/feed?q=hi', { token: HOUSEMATE })).status, 403);
    assert.equal(h.records('query').length, before,
      'a refused request reached the SDK — the guard is running too late');
  });

  test('keeps refusing a bad token after admitting a good one', async () => {
    // The verdict cache is keyed per token. If it ever latched open, a single
    // authenticated call would unlock the endpoint for everyone.
    assert.equal((await h.get('/diag', { token: ADMIN })).status, 200);
    assert.equal((await h.get('/diag', { token: 'not-a-real-token' })).status, 401);
    assert.equal((await h.get('/diag')).status, 401);
    assert.equal((await h.get('/diag', { token: ADMIN })).status, 200);
  });
});

describe('the /diag guard when Home Assistant cannot be reached', () => {
  let h, core;

  before(async () => {
    // Start a fake, take its URL, then stop it: nothing is listening there now,
    // which is what a restarting Core or a broken network looks like.
    core = await startFakeCore({ tokens: { [ADMIN]: { isAdmin: true } } });
    const deadUrl = core.wsUrl;
    await core.stop();
    h = await startServer({ env: { DEBUG_MODE: 'true', HA_CORE_WS_URL: deadUrl } });
  });
  after(async () => { await h.stop(); });

  test('fails closed rather than open', async () => {
    const res = await h.get('/diag', { token: ADMIN });
    assert.equal(res.status, 503, 'an unvalidatable token must not be treated as valid');
    assert.equal(res.json?.error, 'auth_unavailable');
  });
});
