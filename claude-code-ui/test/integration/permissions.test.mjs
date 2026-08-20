/*
 * Permission modes. The behaviour that matters is not "does a prompt appear" but
 * what the SDK is ultimately told — so most assertions read the decision the
 * stub recorded, not just the wire message.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

const bashTool = (extra = {}) => ({ name: 'Bash', input: { command: 'ls' }, id: 'tool-bash', ...extra });

describe('ask mode', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [{
            tool: bashTool({
              title: 'Run a command',
              description: 'ls',
              suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }],
            }),
          }],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('prompts, and an allow reaches the SDK as allow', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'list files', permissionMode: 'ask' });

    const req = await c.waitFor('permission_request');
    assert.equal(req.toolName, 'Bash');
    assert.deepEqual(req.input, { command: 'ls' });
    assert.equal(req.title, 'Run a command');
    assert.equal(req.canAlways, true);
    assert.equal(req.alwaysLabel, 'Bash(ls:*)', 'the Always button says what it will remember');

    c.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    await c.waitFor('result');

    const decision = h.records('tool_decision').at(-1);
    assert.equal(decision.outcome.behavior, 'allow');
    assert.equal(decision.outcome.updatedPermissions, undefined, 'a plain allow does not persist a rule');
  });
});

describe('the Always button', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [{
            tool: bashTool({ suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }] }),
          }],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('hands the suggested rule back so the decision sticks to the tool', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'list files', permissionMode: 'ask' });
    const req = await c.waitFor('permission_request');
    c.send({ type: 'permission_response', id: req.id, decision: 'always' });
    await c.waitFor('result');

    const outcome = h.records('tool_decision').at(-1).outcome;
    assert.equal(outcome.behavior, 'allow');
    assert.equal(outcome.updatedPermissions.length, 1);
  });
});

describe('denying', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('is reported to the model, and the transcript marks it as a real failure', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'list files', permissionMode: 'ask' });
    const req = await c.waitFor('permission_request');
    c.send({ type: 'permission_response', id: req.id, decision: 'deny' });

    const res = await c.waitFor('tool_result');
    assert.equal(res.isError, true);
    assert.equal(res.answered, false, 'a denial is not an answered question');
    assert.match(h.records('tool_decision').at(-1).outcome.message, /Denied by user/);
  });
});

describe('acceptEdits mode', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { tool: { name: 'Write', input: { file_path: '/config/x.yaml' }, id: 'w' } },
            { tool: bashTool() },
          ],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('auto-approves file edits and still prompts for everything else', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'edit and run', permissionMode: 'acceptEdits' });

    const req = await c.waitFor('permission_request');
    assert.equal(req.toolName, 'Bash', 'the Write went through without asking');
    c.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    await c.waitFor('result');

    const decisions = h.records('tool_decision');
    assert.equal(decisions[0].outcome.behavior, 'allow');
    assert.equal(c.all('permission_request').length, 1);
  });
});

describe('plan mode', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: {
        runs: [{
          steps: [
            { tool: { name: 'Read', input: { file_path: '/config/a' }, id: 'r' } },
            { tool: { name: 'ExitPlanMode', input: { plan: 'do the thing' }, id: 'x' } },
          ],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('runs read-only tools silently and only asks to leave plan mode', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'plan it', permissionMode: 'plan' });

    const req = await c.waitFor('permission_request');
    assert.equal(req.toolName, 'ExitPlanMode');
    c.send({ type: 'permission_response', id: req.id, decision: 'allow' });
    await c.waitFor('result');

    assert.equal(h.records('query').at(-1).options.permissionMode, 'plan',
      'plan is SDK-native, so the SDK must also be told');
    assert.equal(c.all('permission_request').length, 1);
  });
});

describe('auto mode', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('hands approval to the SDK classifier and never prompts', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'auto' });
    await c.waitFor('result');

    const q = h.records('query').at(-1);
    assert.equal(q.options.permissionMode, 'auto');
    assert.equal(q.options.hasCanUseTool, false, 'auto mode has no canUseTool at all');
    assert.equal(c.all('permission_request').length, 0);
  });
});

describe('switching mode mid-prompt', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('to bypass resolves the prompt already on screen', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'ask' });
    const req = await c.waitFor('permission_request');

    c.send({ type: 'set_perm_mode', mode: 'bypass' });
    const resolved = await c.waitFor('permission_resolved');
    assert.equal(resolved.id, req.id, 'the UI is told to dismiss that exact card');

    await c.waitFor('result');
    assert.equal(h.records('tool_decision').at(-1).outcome.behavior, 'allow');
  });
});

describe('the browser going away mid-prompt', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ tool: bashTool() }] }] } });
  });
  after(async () => { await h.stop(); });

  test('denies the pending permission rather than hanging the run', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'ask' });
    await c.waitFor('permission_request');
    await c.close();

    const decision = await h.waitForRecord((r) => r.kind === 'tool_decision');
    assert.equal(decision.outcome.behavior, 'deny');
  });
});

describe('a tool prompt with nobody connected at all', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: { runs: [{ steps: [{ sleep: 400 }, { tool: bashTool() }] }] },
    });
  });
  after(async () => { await h.stop(); });

  test('is denied, not left waiting forever', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'do it', permissionMode: 'ask' });
    await h.waitForRecord((r) => r.kind === 'query');
    await c.close();

    const decision = await h.waitForRecord((r) => r.kind === 'tool_decision');
    assert.equal(decision.outcome.behavior, 'deny');
    await h.waitForLog('no client is connected — denying');
  });
});
