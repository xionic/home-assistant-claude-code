/*
 * AskUserQuestion. The tool never actually runs: it is intercepted and the
 * user's answer is delivered to the model as a *denial* message. Two things have
 * historically gone wrong here and both are pinned below — the answer arriving
 * as is_error and being rendered in red, and a backgrounded phone silently
 * answering "closed without answering" on the user's behalf.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, userLine, assistantLine } from '../helpers/server-harness.mjs';

const questionInput = {
  questions: [{ header: 'Room', question: 'Which room?', options: [{ label: 'Hall' }, { label: 'Kitchen' }] }],
};
const askStep = { tool: { name: 'AskUserQuestion', input: questionInput, id: 'q1' } };

for (const mode of ['ask', 'auto']) {
  describe(`a question in ${mode} mode`, () => {
    let h;
    before(async () => {
      h = await startServer({ scenario: { runs: [{ steps: [askStep] }] } });
    });
    after(async () => { await h.stop(); });

    test('reaches the browser and the answer reaches the model', async () => {
      const c = await h.connect();
      await c.waitFor('history');
      c.send({ type: 'prompt', text: 'which room?', permissionMode: mode });

      const dialog = await c.waitFor('user_dialog');
      assert.equal(dialog.dialogKind, 'askUserQuestion');
      assert.deepEqual(dialog.payload.questions[0].options.map((o) => o.label), ['Hall', 'Kitchen']);

      c.send({ type: 'user_dialog_response', id: dialog.id, result: { answers: { Room: 'Kitchen' } } });

      const res = await c.waitFor('tool_result');
      assert.match(res.output, /The user answered your question\(s\):\n- Room: Kitchen/);
      assert.equal(res.answered, true, 'rendered as an answer…');
      assert.equal(res.isError, false, '…not as a failure');
    });
  });
}

describe('skipping a question', () => {
  let h;
  before(async () => { h = await startServer({ scenario: { runs: [{ steps: [askStep] }] } }); });
  after(async () => { await h.stop(); });

  test('tells the model nobody answered and lets it carry on', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'which room?', permissionMode: 'ask' });
    const dialog = await c.waitFor('user_dialog');
    c.send({ type: 'user_dialog_response', id: dialog.id });

    const res = await c.waitFor('tool_result');
    assert.match(res.output, /closed the question dialog without answering/);
    assert.equal(res.answered, true);
  });
});

describe('a multi-select answer', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [{
            tool: {
              name: 'AskUserQuestion', id: 'q1',
              input: { questions: [{ header: 'Rooms', question: 'Which?', multiSelect: true, options: [] }] },
            },
          }],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('is flattened into one readable line', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'which rooms?', permissionMode: 'ask' });
    const dialog = await c.waitFor('user_dialog');
    c.send({ type: 'user_dialog_response', id: dialog.id, result: { answers: { Rooms: ['Hall', 'Kitchen'] } } });
    const res = await c.waitFor('tool_result');
    assert.match(res.output, /- Rooms: Hall, Kitchen/);
  });
});

describe('a question left waiting while the browser goes away', () => {
  let h;
  before(async () => { h = await startServer({ scenario: { runs: [{ steps: [askStep] }] } }); });
  after(async () => { await h.stop(); });

  test('survives the disconnect and is replayed to the next tab', async () => {
    const a = await h.connect();
    await a.waitFor('history');
    a.send({ type: 'prompt', text: 'which room?', permissionMode: 'ask' });
    const dialog = await a.waitFor('user_dialog');
    await a.close();

    // A phone backgrounding its browser drops the socket routinely. That must not
    // answer the question on the user's behalf.
    const b = await h.connect();
    const replayed = await b.waitFor('user_dialog');
    assert.equal(replayed.id, dialog.id);

    b.send({ type: 'user_dialog_response', id: replayed.id, result: { answers: { Room: 'Hall' } } });
    const res = await b.waitFor('tool_result');
    assert.match(res.output, /- Room: Hall/);
  });
});

describe('answering a question in one tab', () => {
  let h;
  before(async () => { h = await startServer({ scenario: { runs: [{ steps: [askStep] }] } }); });
  after(async () => { await h.stop(); });

  test('closes the card in the others', async () => {
    const a = await h.connect();
    const b = await h.connect();
    await Promise.all([a.waitFor('history'), b.waitFor('history')]);
    a.send({ type: 'prompt', text: 'which room?', permissionMode: 'ask' });
    const dialog = await b.waitFor('user_dialog');
    a.send({ type: 'user_dialog_response', id: dialog.id, result: { answers: { Room: 'Hall' } } });
    const cancelled = await b.waitFor('user_dialog_cancelled');
    assert.equal(cancelled.id, dialog.id);
  });
});

describe('stopping a turn with a question on screen', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [askStep] }] } });
  });
  after(async () => { await h.stop(); });

  test('takes the question down instead of leaving it hanging', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'which room?', permissionMode: 'ask' });
    const dialog = await c.waitFor('user_dialog');
    c.send({ type: 'abort' });
    const cancelled = await c.waitFor('user_dialog_cancelled');
    assert.equal(cancelled.id, dialog.id);
  });
});

describe('an answered question already in the transcript', () => {
  let h;
  before(async () => {
    h = await startServer({
      sessions: {
        's1': [
          userLine('which room?'),
          assistantLine([{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: questionInput }]),
          { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'q1', is_error: true,
              content: 'The user answered your question(s):\n- Room: Hall' },
          ] } },
        ],
        // A transcript truncated above the tool_use — the name is gone, so the
        // answer has to be recognised from its text alone.
        's2': [
          userLine('earlier'),
          { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'orphan', is_error: true,
              content: 'The user answered your question(s):\n- Room: Kitchen' },
          ] } },
        ],
      },
      data: { 'active-session.json': { sessionId: 's1' } },
    });
  });
  after(async () => { await h.stop(); });

  test('is still an answer after a reload, not a red failure', async () => {
    const c = await h.connect();
    const hist = await c.waitFor('history');
    const res = hist.items.find((i) => i.kind === 'tool_result');
    assert.equal(res.answered, true);
    assert.equal(res.isError, false);
  });

  test('is recognised even when the tool call itself is no longer in the file', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'session_switch', id: 's2' });
    const hist = await c.waitFor((m) => m.type === 'history' && m.items.some((i) => i.kind === 'tool_result'));
    const res = hist.items.find((i) => i.kind === 'tool_result');
    assert.equal(res.answered, true);
    assert.equal(res.isError, false);
  });
});
