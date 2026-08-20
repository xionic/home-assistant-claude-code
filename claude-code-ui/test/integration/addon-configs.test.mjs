/*
 * The /addon_configs guard. HA folder maps are static — the mount is always
 * there — so the app option is the only thing gating access, enforced by a
 * PreToolUse hook that runs in every permission mode and short-circuits the tool
 * before it executes.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

const readOtherApp = { name: 'Read', input: { file_path: '/addon_configs/core_mosquitto/acl.conf' }, id: 't1' };
const grepAcrossAll = { name: 'Grep', input: { pattern: 'password', path: '/addon_configs' }, id: 't2' };
const bashAtIt = { name: 'Bash', input: { command: 'cat /addon_configs/core_mosquitto/acl.conf' }, id: 't3' };
const ownConfig = { name: 'Read', input: { file_path: '/config/configuration.yaml' }, id: 't4' };

describe('with access disabled (the default)', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: { runs: [{ steps: [{ tool: readOtherApp }, { tool: grepAcrossAll }, { tool: bashAtIt }, { tool: ownConfig }] }] },
    });
  });
  after(async () => { await h.stop(); });

  test('blocks Read, Grep and Bash alike, and leaves /config alone', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    // bypass would allow everything if the guard were canUseTool rather than a hook.
    c.send({ type: 'prompt', text: 'peek at the neighbours', permissionMode: 'bypass' });
    await c.waitFor('result');

    const decisions = h.records('tool_decision');
    assert.equal(decisions.length, 4);
    for (const d of decisions.slice(0, 3)) {
      assert.equal(d.outcome.behavior, 'deny', `${d.tool} should be denied`);
      assert.equal(d.outcome.via, 'hook', 'denied before canUseTool ever saw it');
      assert.match(d.outcome.message, /Allow access to other app configs/);
    }
    assert.equal(decisions[3].outcome.behavior, 'allow', '/config is the working directory, not a neighbour');
  });
});

describe('with access enabled', () => {
  let h;
  before(async () => {
    h = await startServer({
      env: { ALLOW_ADDON_CONFIGS: 'true' },
      scenario: { runs: [{ steps: [{ tool: readOtherApp }] }] },
    });
  });
  after(async () => { await h.stop(); });

  test('lets the call through, and registers no hook at all', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'read it', permissionMode: 'bypass' });
    await c.waitFor('result');

    assert.equal(h.records('tool_decision').at(-1).outcome.behavior, 'allow');
    assert.equal(h.records('query').at(-1).options.preToolUseHooks, 0,
      'no guard to run means no per-tool-call round trip');
  });
});

describe('with ESPHome enabled but broad access still off', () => {
  let h;
  before(async () => {
    h = await startServer({
      env: { ENABLE_ESPHOME: 'true', ESPHOME_CONFIG_DIR: '/addon_configs/core_esphome' },
      scenario: {
        runs: [{
          steps: [
            { tool: { name: 'Read', input: { file_path: '/addon_configs/core_esphome/boiler.yaml' }, id: 'e1' } },
            { tool: readOtherApp },
            { tool: { name: 'Bash', input: { command: 'cp /addon_configs/core_esphome/a.yaml /addon_configs/core_mosquitto/b' }, id: 'e2' } },
          ],
        }],
      },
    });
  });
  after(async () => { await h.stop(); });

  test('carves out only the ESPHome folder', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'flash the boiler', permissionMode: 'bypass' });
    await c.waitFor('result');

    const [esphome, other, mixed] = h.records('tool_decision');
    assert.equal(esphome.outcome.behavior, 'allow');
    assert.equal(other.outcome.behavior, 'deny');
    assert.equal(mixed.outcome.behavior, 'deny', 'one foot outside the carve-out is still outside it');
  });
});
