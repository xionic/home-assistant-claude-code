/*
 * Slash commands over the wire: what the browser is actually offered, and that
 * a tab connecting later is offered the same thing.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

const init = (commands, terminal) => ({
  emit: {
    type: 'system', subtype: 'init', session_id: '{{SESSION_ID}}', model: 'claude-opus-5',
    slash_commands: commands,
    ...(terminal ? { terminal_slash_commands: terminal } : {}),
  },
});

describe('a CLI that tags its terminal-only commands', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [init(['compact', 'exit', 'clear', 'statusline'], ['exit', 'statusline'])],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('does not offer them in a browser, which has no terminal to exit', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });

    const offered = await c.waitFor((m) => m.type === 'slash_commands' && m.commands.length);
    assert.deepEqual(offered.commands, ['compact', 'clear']);
  });

  test('and a tab that connects afterwards is offered the same list', async () => {
    const later = await h.connect();
    const greeting = await later.waitFor('slash_commands');
    assert.deepEqual(greeting.commands, ['compact', 'clear']);
  });
});

describe('a CLI that does not tag anything', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: { runs: [{ steps: [init(['compact', 'clear'])] }] },
    });
  });
  after(async () => { await h.stop(); });

  test('has every command offered — an absent tag is not an empty menu', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });
    const offered = await c.waitFor((m) => m.type === 'slash_commands' && m.commands.length);
    assert.deepEqual(offered.commands, ['compact', 'clear']);
  });
});
