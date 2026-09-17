/*
 * The model catalog over the wire: what the browser is offered after a turn,
 * that a tab connecting later gets the same thing, and that an older CLI
 * without supportedModels() (or one that throws) doesn't break the run.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

describe('a CLI that reports its model catalog', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ text: 'ok' }] }] } });
  });
  after(async () => { await h.stop(); });

  test('broadcasts it to connected clients once the run starts', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });

    const offered = await c.waitFor((m) => m.type === 'models' && m.models?.length);
    assert.deepEqual(offered.models.map((m) => m.value),
      ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    assert.equal(offered.models[0].displayName, 'Fable 5.1');
  });

  test('and a tab that connects afterwards is greeted with the cached list', async () => {
    const later = await h.connect();
    const greeting = await later.waitFor((m) => m.type === 'models' && m.models?.length);
    assert.deepEqual(greeting.models.map((m) => m.value),
      ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });
});

describe('a tab connecting before any run has happened', () => {
  let h;
  before(async () => { h = await startServer(); });
  after(async () => { await h.stop(); });

  test('is greeted with an empty catalog — the static list stays the fallback', async () => {
    const c = await h.connect();
    const greeting = await c.waitFor('models');
    assert.deepEqual(greeting.models, []);
  });
});

describe('a CLI without a working supportedModels()', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: { runs: [{ steps: [{ text: 'ok' }], modelsThrow: 'not implemented' }] },
    });
  });
  after(async () => { await h.stop(); });

  test('still completes the run normally, with no non-empty catalog broadcast', async () => {
    const c = await h.connect();
    await c.waitFor('history');   // the greeting's own 'models' (empty, pre-run) precedes this
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });

    await c.waitFor((m) => m.type === 'result' || m.type === 'text');
    assert.ok(c.all('models').every((m) => !m.models?.length),
      'a run whose supportedModels() throws must not broadcast a catalog');
  });
});
