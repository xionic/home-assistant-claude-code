/*
 * The ha-tools CLI. Its consumer is an agent reading stdout, so the output shape
 * *is* the API — these assertions are the design rules from CLAUDE.md made
 * executable:
 *
 *   - empty is [], broken is a non-zero exit, and the two never look alike
 *   - times are Home Assistant's timezone with an explicit offset, never epochs
 *   - a failure says what failed, not what it guesses caused it
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startFakeHa, runTool, historyPoints, fakeConfigDir, TOKEN } from '../helpers/fake-ha.mjs';

// 2026-01-15 09:30:00 UTC — inside GMT, so Europe/London is +00:00,
// which makes a timezone bug show up as a *missing* offset rather than a wrong one.
const T0 = Date.UTC(2026, 0, 15, 9, 30, 0);
// 2026-07-15 09:30:00 UTC — inside BST, so Europe/London is +01:00.
const SUMMER = Date.UTC(2026, 6, 15, 9, 30, 0);

const londonConfig = { time_zone: 'Europe/London' };

describe('the dispatcher', () => {
  test('lists every subcommand, so an agent can check rather than guess', async () => {
    const r = await runTool('ha-tools', ['--help']);
    assert.equal(r.code, 0);
    for (const sub of ['timeline', 'history', 'stats', 'logs', 'automation', 'trace-watch',
      'config-check', 'reload', 'lovelace', 'ws']) {
      assert.match(r.stdout, new RegExp(`\\b${sub}\\b`), `--help does not mention ${sub}`);
    }
  });

  test('rejects an unknown subcommand with exit 2, not a stack trace', async () => {
    const r = await runTool('ha-tools', ['bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command 'bogus'/);
  });

  test('answers as the name it was invoked by', async () => {
    const asAlias = await runTool('ha-history', ['--help']);
    assert.match(asAlias.stderr + asAlias.stdout, /ha-history/);
    assert.doesNotMatch(asAlias.stderr + asAlias.stdout, /ha-tools history </);
  });
});

describe('history', () => {
  let ha;
  before(async () => {
    ha = await startFakeHa({
      commands: {
        get_config: londonConfig,
        'history/history_during_period': (msg) => {
          if (msg.entity_ids[0] === 'sensor.missing') return {};
          return {
            'sensor.temperature': historyPoints('sensor.temperature', [
              { ms: SUMMER, state: '19.5' },
              { ms: SUMMER + 60000, state: '19.8' },
            ]),
          };
        },
      },
    });
  });
  after(async () => { await ha.close(); });

  test('prints Home Assistant time with an explicit offset, never an epoch', async () => {
    const r = await runTool('ha-history', ['sensor.temperature', '--format', 'tsv'], { ha });
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'timestamp\tentity_id\tstate');
    assert.match(r.lines[1], /^2026-07-15 10:30:00\+01:00\tsensor\.temperature\t19\.5$/);
    assert.doesNotMatch(r.stdout, /\b17\d{8}\b/, 'a raw epoch reached the output');
  });

  test('--utc opts out of the local clock', async () => {
    const r = await runTool('ha-history', ['sensor.temperature', '--format', 'tsv', '--utc'], { ha });
    assert.match(r.lines[1], /^2026-07-15 09:30:00\+00:00\t/);
  });

  test('a silent entity is an empty result, not a failure', async () => {
    const r = await runTool('ha-history', ['sensor.missing', '--format', 'json'], { ha });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, {});
  });

  test('asks HA for the range it was given', async () => {
    await runTool('ha-history', ['sensor.temperature', '--days', '3'], { ha });
    const sent = ha.requests.filter((q) => q.ws === 'history/history_during_period').at(-1).message;
    const spanDays = (Date.now() - Date.parse(sent.start_time)) / 86400000;
    assert.ok(spanDays > 2.9 && spanDays < 3.1, `asked for ${spanDays} days`);
    assert.equal(sent.end_time, undefined, 'no --to means "up to now"');
  });

  test('a bad --format is a usage error, exit 2', async () => {
    const r = await runTool('ha-history', ['sensor.temperature', '--format', 'yaml'], { ha });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid --format/i);
  });
});

describe('stats', () => {
  let ha;
  before(async () => {
    ha = await startFakeHa({
      commands: {
        get_config: londonConfig,
        'recorder/statistics_during_period': {
          'sensor.energy': [{ start: T0, mean: 1.5, min: 1, max: 2, sum: 10, state: 3, change: 0.5 }],
        },
      },
    });
  });
  after(async () => { await ha.close(); });

  test('prints a header and one row per bucket', async () => {
    const r = await runTool('ha-stats', ['sensor.energy', '--format', 'tsv'], { ha });
    assert.equal(r.code, 0);
    assert.equal(r.lines[0], 'start\tstatistic_id\tmean\tmin\tmax\tsum\tstate\tchange');
    assert.match(r.lines[1], /^2026-01-15 09:30:00\+00:00\tsensor\.energy\t1\.5\t/);
  });

  test('rejects an invalid --period rather than asking HA for nonsense', async () => {
    const r = await runTool('ha-stats', ['sensor.energy', '--period', 'fortnight'], { ha });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid --period/);
  });
});

describe('timeline', () => {
  let ha;
  before(async () => {
    ha = await startFakeHa({
      commands: {
        get_config: londonConfig,
        'history/history_during_period': (msg) => {
          const all = {
            'light.hall': historyPoints('light.hall', [
              { ms: SUMMER, state: 'on' },
              { ms: SUMMER + 120000, state: 'off' },
            ]),
            'binary_sensor.stairs': historyPoints('binary_sensor.stairs', [
              { ms: SUMMER + 60000, state: 'on' },
            ]),
          };
          return Object.fromEntries(
            Object.entries(all).filter(([id]) => msg.entity_ids.includes(id)));
        },
      },
    });
  });
  after(async () => { await ha.close(); });

  test('merges several entities onto one clock, in order', async () => {
    const r = await runTool('ha-timeline', ['light.hall', 'binary_sensor.stairs'], { ha });
    assert.equal(r.code, 0);
    assert.match(r.lines[0], /^# times are Europe\/London \(UTC\+01:00\); 3 events$/);
    const order = r.lines.slice(1).map((l) => l.split(/\s+/)[2]);
    assert.deepEqual(order, ['light.hall', 'binary_sensor.stairs', 'light.hall']);
  });

  test('names entities that returned nothing, so a typo is not read as silence', async () => {
    const r = await runTool('ha-timeline', ['light.hall', 'light.nonexistent'], { ha });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /no events in this window for light\.nonexistent/);
  });

  test('--between filters on the wall clock the rows are printed in', async () => {
    const inside = await runTool('ha-timeline', ['light.hall', '--between', '10:00-11:00', '--format', 'json'], { ha });
    assert.equal(inside.json.event_count, 2, 'both hall events are 10:30 London time');
    const outside = await runTool('ha-timeline', ['light.hall', '--between', '02:00-03:00', '--format', 'json'], { ha });
    assert.equal(outside.json.event_count, 0);
  });

  test('a window that wraps midnight includes both sides of it', async () => {
    const r = await runTool('ha-timeline', ['light.hall', '--between', '22:00-11:00', '--format', 'json'], { ha });
    assert.equal(r.json.event_count, 2);
  });

  test('json output states its timezone and carries both a stamp and an epoch', async () => {
    const r = await runTool('ha-timeline', ['light.hall', '--format', 'json'], { ha });
    assert.equal(r.json.timezone, 'Europe/London');
    assert.match(r.json.events[0].time, /\+01:00$/);
    assert.equal(typeof r.json.events[0].epoch_ms, 'number');
  });
});

describe('automation', () => {
  const states = [
    { entity_id: 'automation.hall_light_off', state: 'on',
      attributes: { id: '1699', friendly_name: 'Hall light off', last_triggered: '2026-07-15T09:30:00+00:00' } },
    { entity_id: 'light.hall', state: 'on', attributes: {} },
  ];
  let ha;
  before(async () => {
    ha = await startFakeHa({
      commands: {
        get_config: londonConfig,
        get_states: states,
        'automation/config': { config: { alias: 'Hall light off', triggers: [{ trigger: 'state' }], actions: [{ action: 'light.turn_off' }] } },
      },
    });
  });
  after(async () => { await ha.close(); });

  test('list reports only automations, with their editor id', async () => {
    const r = await runTool('ha-tools', ['automation', 'list'], { ha });
    assert.equal(r.code, 0);
    assert.equal(r.json.count, 1);
    assert.equal(r.json.automations[0].id, '1699');
    assert.match(r.json.automations[0].last_triggered, /\+01:00$/);
  });

  test('show says which key spelling HA actually returned', async () => {
    const r = await runTool('ha-tools', ['automation', 'show', 'automation.hall_light_off'], { ha });
    assert.equal(r.json.schema, 'plural', 'triggers:/actions: is what silently breaks parsers');
    assert.deepEqual(r.json.summary, { triggers: 1, conditions: 0, actions: 1 });
    assert.equal(r.json.source, 'websocket automation/config');
  });

  test('resolves an automation by numeric id and by friendly name too', async () => {
    for (const ref of ['1699', 'hall light off', 'hall_light_off']) {
      const r = await runTool('ha-tools', ['automation', 'show', ref], { ha });
      assert.equal(r.code, 0, `could not resolve ${ref}: ${r.stderr}`);
      assert.equal(r.json.entity_id, 'automation.hall_light_off');
    }
  });

  test('an unknown automation fails loudly and points at the list command', async () => {
    const r = await runTool('ha-tools', ['automation', 'show', 'automation.nope'], { ha });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no automation matching "automation\.nope"/);
    assert.match(r.stderr, /ha-tools automation list/);
  });

  test('yaml shows the block from automations.yaml with line numbers', async () => {
    const dir = fakeConfigDir([
      '- id: "1699"',
      '  alias: Hall light off',
      '  trigger:',
      '    - platform: state',
      '',
      '- id: "1700"',
      '  alias: Something else',
      '',
    ].join('\n'));
    const r = await runTool('ha-tools', ['automation', 'yaml', '1699'], { ha, env: { HA_CONFIG_DIR: dir } });
    assert.equal(r.code, 0);
    assert.match(r.lines[0], /lines 1-4 — automation\.hall_light_off/);
    assert.match(r.lines[1], /^\s*1\s+- id: "1699"$/);
    assert.equal(r.lines.some((l) => l.includes('Something else')), false, 'the next block is not part of this one');
  });
});

describe('config-check and reload', () => {
  test('a valid config exits 0 and an invalid one exits 1', async () => {
    const good = await startFakeHa({ rest: { 'core/api/config/core/check_config': { result: 'valid', errors: null } } });
    const bad = await startFakeHa({ rest: { 'core/api/config/core/check_config': { result: 'invalid', errors: 'bad indentation' } } });
    try {
      const ok = await runTool('ha-tools', ['config-check'], { ha: good });
      assert.equal(ok.code, 0);
      assert.equal(ok.json.result, 'valid');

      const nope = await runTool('ha-tools', ['config-check'], { ha: bad });
      assert.equal(nope.code, 1, 'a caller must be able to branch on the exit code alone');
      assert.equal(nope.json.result, 'invalid');
    } finally {
      await good.close(); await bad.close();
    }
  });

  test('reload defaults to automations and can name another domain', async () => {
    const ha = await startFakeHa({
      rest: {
        'core/api/services/automation/reload': {},
        'core/api/services/homeassistant/reload_all': {},
      },
    });
    try {
      const auto = await runTool('ha-tools', ['reload'], { ha });
      assert.deepEqual(auto.json, { reloaded: 'automation', service: 'automation.reload' });
      const all = await runTool('ha-tools', ['reload', 'all'], { ha });
      assert.deepEqual(all.json, { reloaded: 'all', service: 'homeassistant.reload_all' });
    } finally {
      await ha.close();
    }
  });

  test('a Supervisor that refuses is an error, not an empty success', async () => {
    const ha = await startFakeHa({ status: { 'core/api/config/core/check_config': 502 } });
    try {
      const r = await runTool('ha-tools', ['config-check'], { ha });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /HTTP 502/);
    } finally {
      await ha.close();
    }
  });
});

describe('lovelace', () => {
  let ha;
  before(async () => {
    ha = await startFakeHa({
      commands: {
        'lovelace/dashboards/list': [{ id: 'abc', url_path: 'energy', title: 'Energy' }],
        'lovelace/config': { views: [{ title: 'Home' }] },
      },
    });
  });
  after(async () => { await ha.close(); });

  test('lists dashboards over the WebSocket API (REST 404s on modern HA)', async () => {
    const r = await runTool('ha-lovelace', ['list'], { ha });
    assert.equal(r.code, 0);
    assert.equal(r.json[0].url_path, 'energy');
  });

  test('get asks for the live config, not a cached one', async () => {
    const r = await runTool('ha-lovelace', ['get', 'energy'], { ha });
    assert.equal(r.code, 0);
    const sent = ha.requests.filter((q) => q.ws === 'lovelace/config').at(-1).message;
    assert.equal(sent.force, true);
    assert.equal(sent.url_path, 'energy');
  });
});

describe('a Home Assistant that will not authenticate', () => {
  test('is reported as an auth failure, not as empty data', async () => {
    const ha = await startFakeHa({ authFails: true });
    try {
      const r = await runTool('ha-history', ['sensor.x'], { ha });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /authentication failed/i);
    } finally {
      await ha.close();
    }
  });

  test('and no token at all is refused before any connection is attempted', async () => {
    const r = await runTool('ha-history', ['sensor.x'], { env: { HA_TOKEN: '', SUPERVISOR_TOKEN: '' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no SUPERVISOR_TOKEN or HA_TOKEN/);
  });
});
