/*
 * The HTTP surface: the SPA, attachments, and the diagnostic routes — which must
 * be genuinely absent (not merely refusing) unless the `debug` option is on.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { startServer, userLine } from '../helpers/server-harness.mjs';

describe('with debug off', () => {
  let h;
  before(async () => { h = await startServer({}); });
  after(async () => { await h.stop(); });

  test('serves the app', async () => {
    const res = await h.get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>/i);
  });

  test('falls through unknown paths to the app, so ingress deep links work', async () => {
    const res = await h.get('/some/deep/link');
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>/i);
  });

  test('has no diagnostic routes at all', async () => {
    for (const route of ['/diag', '/diag/config', '/diag/sesslist', '/diag/conv']) {
      const res = await h.get(route);
      assert.equal(res.json, null, `${route} answered with JSON while debug is off`);
      assert.match(res.text, /<title>/i);
    }
  });
});

describe('with debug on', () => {
  let h;
  before(async () => {
    h = await startServer({
      env: { DEBUG_MODE: 'true' },
      sessions: { 'sess': [userLine('a question')] },
      data: { 'active-session.json': { sessionId: 'sess' } },
    });
  });
  after(async () => { await h.stop(); });

  test('/diag reports the environment and runs its probes', async () => {
    const res = await h.get('/diag');
    assert.equal(res.status, 200);
    assert.equal(res.json.env.has_SUPERVISOR_TOKEN, false, 'no token in the test environment');
    assert.ok('ws_ping' in res.json.tests);
    assert.ok('rest_states' in res.json.tests);
  });

  test('/diag/conv shows the active session and its transcript', async () => {
    const res = await h.get('/diag/conv');
    assert.equal(res.json.activeSessionId, 'sess');
    assert.equal(res.json.count, 1);
    assert.equal(res.json.sessionCount, 1);
  });

  test('/diag/sesslist lists the store, and ?id= dumps one transcript', async () => {
    const list = await h.get('/diag/sesslist');
    assert.deepEqual(list.json.sessions.map((s) => s.id), ['sess']);
    const one = await h.get('/diag/sesslist?id=sess');
    assert.equal(one.json.items[0].text, 'a question');
  });

  test('/diag/grep searches across every stored session', async () => {
    const res = await h.get('/diag/grep?q=question');
    assert.equal(res.json.sessionsWithHits, 1);
    assert.match(res.json.results[0].snippets[0].text, /a question/);
  });

  test('/diag/config reports which Claude config files exist', async () => {
    const res = await h.get('/diag/config');
    assert.equal(res.json.WORK_DIR, h.workDir);
    assert.ok(Object.keys(res.json.files).length > 0);
  });

  test('/diag/autocontinue can arm a resume without waiting for a real limit', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    const res = await h.get('/diag/autocontinue?simulate=1');
    assert.equal(res.json.enabled, true);
    assert.equal(res.json.timerArmed, true);
    const pending = await c.waitFor('auto_continue_pending');
    assert.equal(pending.rateLimitType, 'five_hour');
  });
});

describe('attachments', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ text: 'I can see it' }] }] } });
  });
  after(async () => { await h.stop(); });

  test('are written to disk and referenced by path so Claude can read them', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({
      type: 'prompt', text: 'what is this?', permissionMode: 'bypass',
      attachments: [{ name: 'photo.png', mediaType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' }],
    });
    await c.waitFor('result');

    const sent = h.records('query').at(-1).prompt;
    assert.match(sent, /what is this\?/);
    assert.match(sent, /The user attached 1 file/);
    assert.match(sent, /Use the Read tool/);

    const uploads = readdirSync(path.join(h.dataDir, 'uploads'));
    assert.equal(uploads.length, 1);
    assert.match(uploads[0], /photo\.png$/);
    assert.match(sent, new RegExp(uploads[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('are served back so the UI can show a thumbnail', async () => {
    const name = readdirSync(path.join(h.dataDir, 'uploads'))[0];
    const res = await h.get(`/uploads/${name}`);
    assert.equal(res.status, 200);
    assert.equal(res.text, 'hello');
  });

  test('with a hostile filename cannot escape the upload directory', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({
      type: 'prompt', text: 'and this', permissionMode: 'bypass',
      attachments: [{ name: '../../etc/passwd', mediaType: 'text/plain', data: 'eA==' }],
    });
    await h.waitForRecord((r) => r.kind === 'query' && r.prompt.includes('and this'));
    for (const f of readdirSync(path.join(h.dataDir, 'uploads'))) {
      assert.ok(!f.includes('/'), `upload name ${f} contains a path separator`);
    }
    assert.equal(existsSync(path.join(h.root, 'etc', 'passwd')), false);
  });
});

describe('old attachments', () => {
  test('are cleaned up on boot so /data cannot grow without bound', async () => {
    const first = await startServer({});
    const stale = path.join(first.dataDir, 'uploads', 'stale.png');
    const fresh = path.join(first.dataDir, 'uploads', 'fresh.png');
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'x');
    const longAgo = Date.now() / 1000 - 30 * 24 * 3600;
    utimesSync(stale, longAgo, longAgo);

    await first.stopServer();
    const second = await startServer({ reuse: first.root });
    try {
      assert.equal(existsSync(stale), false);
      assert.equal(existsSync(fresh), true);
    } finally {
      await second.stop();
    }
  });
});
