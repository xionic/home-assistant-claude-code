/*
 * Multi-session browsing, built directly on Claude Code's own JSONL store so
 * sessions stay interchangeable with the CLI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';

describe('the session list', () => {
  let h;
  before(async () => {
    h = await startServer({
      sessions: {
        'one': [userLine('  Why did the heating fire at 3am?  '), assistantLine([{ type: 'text', text: 'Because…' }])],
        'two': [userLine('Tidy the dashboard')],
        // No user message at all — an empty shell the CLI left behind.
        'junk': [assistantLine([{ type: 'text', text: 'orphaned' }])],
      },
      data: { 'active-session.json': { sessionId: 'one' } },
    });
  });
  after(async () => { await h.stop(); });

  test('titles each session from its first real user message, whitespace tidied', async () => {
    const c = await h.connect();
    const s = await c.waitFor('sessions');
    const titles = s.sessions.map((x) => x.title);
    assert.ok(titles.includes('Why did the heating fire at 3am?'));
    assert.ok(titles.includes('Tidy the dashboard'));
  });

  test('hides sessions with nothing in them', async () => {
    const c = await h.connect();
    const s = await c.waitFor('sessions');
    assert.equal(s.sessions.find((x) => x.id === 'junk'), undefined);
  });

  test('switching loads that transcript and tells every tab', async () => {
    const a = await h.connect();
    const b = await h.connect();
    await Promise.all([a.waitFor('history'), b.waitFor('history')]);
    a.send({ type: 'session_switch', id: 'two' });

    const hist = await b.waitFor((m) => m.type === 'history' && m.items.some((i) => i.text === 'Tidy the dashboard'));
    assert.equal(hist.running, false);
    assert.equal(h.readData('active-session.json').sessionId, 'two');
  });

  test('deleting removes it from the store and clears the chat if it was open', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'session_switch', id: 'two' });
    await c.waitFor((m) => m.type === 'sessions' && m.activeId === 'two');

    c.send({ type: 'session_delete', id: 'two' });
    await c.waitFor('cleared');
    assert.equal(existsSync(path.join(h.store, 'two.jsonl')), false);
    const s = await c.waitFor((m) => m.type === 'sessions' && m.activeId === null);
    assert.equal(s.sessions.find((x) => x.id === 'two'), undefined);
  });

  test('New chat clears the active pointer without touching the transcripts', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'new_session' });
    await c.waitFor('cleared');
    assert.equal(h.readData('active-session.json').sessionId, null);
    assert.equal(existsSync(path.join(h.store, 'one.jsonl')), true);
  });
});

describe('reading a transcript', () => {
  let h;
  before(async () => {
    h = await startServer({
      sessions: {
        's': [
          userLine('a real question'),
          // Slash-command plumbing the CLI records as a user message.
          userLine('<command-name>/compact</command-name>'),
          userLine('<local-command-stdout>compacted</local-command-stdout>'),
          { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
          { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent chatter' } },
          assistantLine([
            { type: 'text', text: 'the answer' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ]),
          { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'file list' },
          ] } },
          'not json at all',
        ],
      },
      data: { 'active-session.json': { sessionId: 's' } },
    });
  });
  after(async () => { await h.stop(); });

  test('drops slash-command echoes, meta and sidechain lines, and survives a corrupt line', async () => {
    const c = await h.connect();
    const hist = await c.waitFor('history');
    assert.deepEqual(hist.items.map((i) => i.kind), ['user', 'text', 'tool_use', 'tool_result']);
    assert.equal(hist.items[0].text, 'a real question');
    assert.equal(hist.items[2].name, 'Bash');
    assert.equal(hist.items[3].output, 'file list');
  });
});

describe('a session pointer left over from a deleted session', () => {
  let h;
  before(async () => {
    h = await startServer({ data: { 'active-session.json': { sessionId: 'gone' } } });
  });
  after(async () => { await h.stop(); });

  test('is dropped on boot rather than replaying an empty chat forever', async () => {
    const c = await h.connect();
    const hist = await c.waitFor('history');
    assert.deepEqual(hist.items, []);
    assert.equal((await c.waitFor('sessions')).activeId, null);
  });
});

describe('the conversation across a restart', () => {
  test('is still there, because it lives in the store rather than in memory', async () => {
    const first = await startServer({
      scenario: { runs: [{ steps: [{ text: 'first answer' }] }] },
    });
    const c = await first.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });
    const session = await c.waitFor('session');
    await c.waitFor('result');

    // The SDK owns the transcript file; write what it would have written.
    writeFileSync(path.join(first.store, `${session.id}.jsonl`),
      [userLine('hello'), assistantLine([{ type: 'text', text: 'first answer' }])]
        .map((l) => JSON.stringify(l)).join('\n') + '\n');

    await first.stopServer();
    const second = await startServer({ reuse: first.root });
    try {
      const c2 = await second.connect();
      const hist = await c2.waitFor('history');
      assert.deepEqual(hist.items.map((i) => i.text), ['hello', 'first answer']);
    } finally {
      await second.stop();
    }
  });
});

describe('persisted MCP servers', () => {
  test('are stripped at startup so a stale one cannot keep loading', async () => {
    const first = await startServer({});
    const file = path.join(first.home, '.claude.json');
    writeFileSync(file, JSON.stringify({
      mcpServers: { 'left-over': { command: 'x' } },
      projects: { '/config': { mcpServers: { 'home-assistant': { command: 'y' } } } },
      otherSettings: { keepMe: true },
    }));
    await first.stopServer();

    const restarted = await startServer({ reuse: first.root });
    try {
      const cleaned = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(cleaned.mcpServers, {});
      assert.deepEqual(cleaned.projects['/config'].mcpServers, {});
      assert.deepEqual(cleaned.otherSettings, { keepMe: true }, 'the rest of the file is left alone');
    } finally {
      await restarted.stop();
    }
  });
});
