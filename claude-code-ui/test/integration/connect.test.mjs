/*
 * What a browser is told the moment it connects, and what a prompt looks like on
 * the wire. These are the messages every other feature is layered on, so they
 * are pinned first.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';

describe('connect handshake', () => {
  let h;
  before(async () => {
    h = await startServer({
      env: { DEFAULT_PERMISSION_MODE: 'acceptEdits' },
      sessions: {
        'sess-a': [userLine('First question about the boiler'), assistantLine([{ type: 'text', text: 'Answer' }])],
      },
      data: { 'active-session.json': { sessionId: 'sess-a' } },
    });
  });
  after(async () => { await h.stop(); });

  test('greets with connected, config, auth, commands, links, sessions and history', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    const order = c.messages.map((m) => m.type);
    assert.deepEqual(order.slice(0, 2), ['connected', 'config']);
    for (const t of ['auth_status', 'slash_commands', 'ha_links', 'sessions', 'history']) {
      assert.ok(order.includes(t), `missing ${t} in ${order.join(', ')}`);
    }
  });

  test('config carries the app option defaults the UI needs', async () => {
    const c = await h.connect();
    const cfg = await c.waitFor('config');
    assert.equal(cfg.defaultPermMode, 'acceptEdits');
    assert.equal(cfg.autoContinue, false);
    assert.equal(cfg.autoContinueSupported, true, 'seeded credentials mean subscription auth');
  });

  test('history replays the active session transcript, not an empty chat', async () => {
    const c = await h.connect();
    const hist = await c.waitFor('history');
    assert.equal(hist.running, false);
    assert.deepEqual(hist.items.map((i) => i.kind), ['user', 'text']);
    assert.equal(hist.items[0].text, 'First question about the boiler');
    assert.ok(hist.items[0].ts > 0, 'items carry a timestamp so the UI can date them after a reload');
  });

  test('session list is titled from the first user message', async () => {
    const c = await h.connect();
    const s = await c.waitFor('sessions');
    assert.equal(s.activeId, 'sess-a');
    assert.deepEqual(s.sessions.map((x) => x.title), ['First question about the boiler']);
  });
});

describe('a prompt end to end', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { text: 'Looking at that now.' },
            { tool: { name: 'Read', input: { file_path: '/config/configuration.yaml' }, id: 'tool-1', output: 'yaml here' } },
            { text: 'Done.' },
          ],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('streams text, tool_use, tool_result, session and result', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'check my config', permissionMode: 'bypass' });

    const result = await c.waitFor('result');
    assert.equal(result.success, true);
    assert.equal(typeof result.inputTokens, 'number');

    assert.deepEqual(c.all('text').map((m) => m.text), ['Looking at that now.', 'Done.']);

    const use = c.last('tool_use');
    assert.equal(use.name, 'Read');
    assert.equal(use.id, 'tool-1');
    assert.deepEqual(use.input, { file_path: '/config/configuration.yaml' });

    const res = c.last('tool_result');
    assert.equal(res.id, 'tool-1');
    assert.equal(res.output, 'yaml here');
    assert.equal(res.isError, false);
    assert.equal(res.answered, false);

    assert.ok(c.last('session').id, 'the SDK session id is published so the client can track it');

    // The context meter is fed *after* the result is broadcast, so a client that
    // stops listening on `result` would never see it.
    const usage = await c.waitFor('context_usage');
    assert.ok(usage.totalTokens > 0);
    assert.ok(usage.maxTokens > 0);
  });

  test('the run reaches the SDK with the working directory and plugins set', async () => {
    const q = h.records('query').at(-1);
    assert.equal(q.options.cwd, h.workDir);
    assert.ok(q.options.plugins.some((p) => p.endsWith('homeassistant-config')));
    assert.deepEqual(q.options.supportedDialogKinds, ['askUserQuestion']);
    assert.deepEqual(q.options.toolConfig, { askUserQuestion: { previewFormat: 'html' } });
  });

  test('a second prompt resumes the session rather than starting a new one', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'and again', permissionMode: 'bypass' });
    await c.waitFor('result');
    const q = h.records('query').at(-1);
    assert.ok(q.options.resume, 'the second run passes resume');
  });

  test('other tabs see the prompt the sending tab typed', async () => {
    const a = await h.connect();
    const b = await h.connect();
    await Promise.all([a.waitFor('history'), b.waitFor('history')]);
    a.send({ type: 'prompt', text: 'hello from tab a', permissionMode: 'bypass' });
    const echoed = await b.waitFor('user');
    assert.equal(echoed.text, 'hello from tab a');
    assert.equal(a.all('user').length, 0, 'the sender rendered it locally already');
  });
});

describe('a long tool result', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{ steps: [{ tool: { name: 'Bash', input: {}, id: 't', output: 'x'.repeat(5000) } }] }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('is truncated so one command cannot flood the transcript', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'run it', permissionMode: 'bypass' });
    const res = await c.waitFor('tool_result');
    assert.ok(res.output.length < 4100);
    assert.ok(res.output.endsWith('…[truncated]'));
  });
});
