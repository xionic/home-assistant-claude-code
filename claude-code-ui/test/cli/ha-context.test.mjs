/*
 * ha-context — the file that becomes Claude's startup knowledge of the house.
 * Whatever it writes, Claude believes, so the assertion that matters most is the
 * negative one: a failed log fetch must say it failed, never hand the error body
 * over as if it were the log.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeHa, TOKEN, APP_ROOT } from '../helpers/fake-ha.mjs';

const SCRIPT = path.join(APP_ROOT, 'scripts', 'ha-context.sh');

const CORE_LOG = [
  '2026-08-12 19:34:02.107 INFO (MainThread) [homeassistant.setup] Setting up sensor',
  '2026-08-12 19:34:09.900 ERROR (MainThread) [custom_components.foo] Boom',
].join('\n');

const HA = {
  rest: {
    'core/info': { data: { version: '2026.8.1', machine: 'raspberrypi4-64' } },
    'host/info': { data: { operating_system: 'Home Assistant OS 15.0', hostname: 'homeassistant' } },
    'core/api/config': { time_zone: 'Europe/London', location_name: 'Home' },
    'core/api/states': [
      { entity_id: 'light.hall', state: 'on', attributes: {} },
      { entity_id: 'light.kitchen', state: 'off', attributes: {} },
      { entity_id: 'sensor.temperature', state: '19.5', attributes: {} },
    ],
    'addons': { data: { addons: [{ name: 'Mosquitto', version: '6.4.1', state: 'started', installed: true }] } },
  },
};

function runContext(args, { ha, env = {} } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('bash', [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SUPERVISOR_TOKEN: TOKEN,
        ...(ha ? { HA_SUPERVISOR_URL: ha.supervisorUrl } : {}),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('a healthy Home Assistant', () => {
  let ha, out, file;
  before(async () => {
    ha = await startFakeHa({ ...HA, logs: { 'core/logs': CORE_LOG } });
    file = path.join(mkdtempSync(path.join(tmpdir(), 'ha-ctx-')), 'ha-context.md');
    out = await runContext(['--output', file], { ha });
  });
  after(async () => { await ha.close(); });

  test('writes the file and says where it went', async () => {
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, new RegExp(`written to ${file}`));
  });

  test('describes the system Claude is about to work on', () => {
    const md = readFileSync(file, 'utf8');
    assert.match(md, /\*\*Home Assistant\*\*: 2026\.8\.1/);
    assert.match(md, /\*\*Timezone\*\*: Europe\/London/);
    assert.match(md, /\*\*OS\*\*: Home Assistant OS 15\.0/);
  });

  test('summarises entities by domain with a total', () => {
    const md = readFileSync(file, 'utf8');
    assert.match(md, /\| light \| 2 \|/);
    assert.match(md, /\| sensor \| 1 \|/);
    assert.match(md, /\*\*Total: 3 entities\*\*/);
  });

  test('lists installed apps', () => {
    assert.match(readFileSync(file, 'utf8'), /- Mosquitto v6\.4\.1 \(started\)/);
  });

  test('includes only real errors from the log, not the whole thing', () => {
    const md = readFileSync(file, 'utf8');
    assert.match(md, /custom_components\.foo\] Boom/);
    assert.doesNotMatch(md, /Setting up sensor/);
  });

  test('teaches the ha-tools commands Claude is expected to use', () => {
    const md = readFileSync(file, 'utf8');
    for (const tool of ['ha-timeline', 'ha-history', 'ha-logs', 'ha-tools config-check']) {
      assert.match(md, new RegExp(tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `context never mentions ${tool}`);
    }
  });
});

describe('a log endpoint that has gone away', () => {
  let ha, file;
  before(async () => {
    ha = await startFakeHa({ ...HA, status: { 'core/logs': 404 } });
    file = path.join(mkdtempSync(path.join(tmpdir(), 'ha-ctx-')), 'ha-context.md');
    await runContext(['--output', file], { ha });
  });
  after(async () => { await ha.close(); });

  test('says the log could not be read instead of passing the error off as log content', () => {
    const md = readFileSync(file, 'utf8');
    assert.doesNotMatch(md, /404: Not Found/, 'this is exactly how the removal of /api/error_log went unnoticed');
    assert.match(md, /Unable to retrieve the Home Assistant log/);
    assert.match(md, /ha-logs/);
  });

  test('and the rest of the context is still generated', () => {
    assert.match(readFileSync(file, 'utf8'), /\*\*Home Assistant\*\*: 2026\.8\.1/);
  });
});

describe('a Home Assistant that is not answering at all', () => {
  let file;
  before(async () => {
    const ha = await startFakeHa({});
    file = path.join(mkdtempSync(path.join(tmpdir(), 'ha-ctx-')), 'ha-context.md');
    await runContext(['--output', file], { ha });
    await ha.close();
  });

  test('degrades to plain "unable to retrieve" rather than inventing a house', () => {
    const md = readFileSync(file, 'utf8');
    assert.match(md, /Unable to retrieve system information/);
    assert.match(md, /Unable to retrieve entity states/);
  });
});

describe('ha-context', () => {
  test('refuses an unknown flag', async () => {
    const r = await runContext(['--everything']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown option: --everything/);
  });

  test('refuses to run with no Supervisor token', async () => {
    const r = await runContext([], { env: { SUPERVISOR_TOKEN: '' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SUPERVISOR_TOKEN not set/);
  });
});
