/*
 * ha-logs. The rule this file exists to hold: **validate on the HTTP status,
 * never the body**. `/api/error_log` was removed from Home Assistant months
 * before anyone noticed, precisely because the string "404: Not Found" is short,
 * non-empty, plausible text — and got pasted into Claude's context as though it
 * were the error log.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHa, runTool } from '../helpers/fake-ha.mjs';

const CORE_LOG = [
  '2026-08-12 19:34:02.107 INFO (MainThread) [homeassistant.setup] Setting up sensor',
  '2026-08-12 19:34:05.221 WARNING (MainThread) [homeassistant.helpers] Slow update',
  '2026-08-12 19:34:09.900 ERROR (MainThread) [custom_components.foo] Boom',
  'Traceback (most recent call last):',
].join('\n');

describe('reading a log', () => {
  let ha;
  before(async () => {
    ha = await startFakeHa({
      logs: {
        'core/logs': CORE_LOG,
        'supervisor/logs': 'supervisor line one',
        'host/logs': 'host line one',
        'addons/self/logs': '[2026-08-12T19:00:00Z] INFO this app',
        'host/logs/identifiers/app_core_mosquitto': '[32m1691234 mosquitto[0m started',
        'host/logs/identifiers': JSON.stringify({ data: { identifiers: ['app_core_mosquitto', 'hassio_supervisor'] } }),
        'host/logs/boots': JSON.stringify({ data: { boots: { 0: '2026-08-12T18:00:00Z' } } }),
      },
    });
  });
  after(async () => { await ha.close(); });

  test('maps each friendly name to its Supervisor endpoint', async () => {
    for (const [source, route] of [
      ['core', 'core/logs'], ['host', 'host/logs'],
      ['supervisor', 'supervisor/logs'], ['self', 'addons/self/logs'],
    ]) {
      const r = await runTool('ha-logs', [source], { ha });
      assert.equal(r.code, 0, `${source} failed: ${r.stderr}`);
      assert.ok(ha.requests.some((q) => q.route === route), `${source} did not hit ${route}`);
    }
  });

  test('treats an unrecognised name as a journal identifier, so any app just works', async () => {
    const r = await runTool('ha-logs', ['app_core_mosquitto'], { ha });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /mosquitto/);
  });

  test('strips the ANSI colour Supervisor sends, unless --raw asks for it', async () => {
    const clean = await runTool('ha-logs', ['app_core_mosquitto'], { ha });
    assert.doesNotMatch(clean.stdout, /\[/, 'escape codes would land in whatever Claude generates');
    const raw = await runTool('ha-logs', ['app_core_mosquitto', '--raw'], { ha });
    assert.match(raw.stdout, /\[/);
  });

  test('--errors keeps warnings, errors and tracebacks and drops the rest', async () => {
    const r = await runTool('ha-logs', ['core', '--errors'], { ha });
    assert.equal(r.code, 0);
    assert.equal(r.lines.length, 3);
    assert.doesNotMatch(r.stdout, /Setting up sensor/);
    assert.match(r.stdout, /Traceback/);
  });

  test('passes the line count and boot through to Supervisor', async () => {
    await runTool('ha-logs', ['core', '-n', '500', '--boot', '0'], { ha });
    const q = ha.requests.filter((x) => x.route === 'core/logs').at(-1).query;
    assert.equal(q.lines, '500');
    assert.equal(q.boot, '0');
  });

  test('--units and --boots list what is available', async () => {
    const units = await runTool('ha-logs', ['--units'], { ha });
    assert.deepEqual(units.lines, ['app_core_mosquitto', 'hassio_supervisor']);
    const boots = await runTool('ha-logs', ['--boots'], { ha });
    assert.match(boots.stdout, /^0\t2026-08-12T18:00:00Z$/m);
  });
});

describe('a Supervisor endpoint that has gone away', () => {
  let ha;
  before(async () => {
    ha = await startFakeHa({
      status: { 'core/logs': 404 },
      logs: { 'host/logs/identifiers': JSON.stringify({ data: { identifiers: [] } }) },
    });
  });
  after(async () => { await ha.close(); });

  test('is an error on stderr with a non-zero exit, never printed as log content', async () => {
    const r = await runTool('ha-logs', ['core'], { ha });
    assert.equal(r.code, 1, 'this is the whole point of the file');
    assert.equal(r.stdout, '', 'the error body must not reach stdout, where it reads as a log');
    assert.match(r.stderr, /returned HTTP 404/);
    assert.match(r.stderr, /Supervisor said: 404: Not Found/);
  });
});

describe('an identifier that logged nothing', () => {
  let ha;
  before(async () => {
    ha = await startFakeHa({
      logs: {
        'host/logs/identifiers/quiet_app': '',
        'host/logs/identifiers/typo_app': '',
        'host/logs/identifiers': JSON.stringify({ data: { identifiers: ['quiet_app'] } }),
      },
    });
  });
  after(async () => { await ha.close(); });

  test('is told apart from an identifier that does not exist', async () => {
    const quiet = await runTool('ha-logs', ['quiet_app'], { ha });
    assert.equal(quiet.code, 0, 'a real unit with nothing to say is not a failure');
    assert.match(quiet.stderr, /No log entries for 'quiet_app'/);

    const typo = await runTool('ha-logs', ['typo_app'], { ha });
    assert.equal(typo.code, 1, 'a name that does not exist is');
    assert.match(typo.stderr, /no journal identifier 'typo_app'/);
  });
});

describe('ha-logs without a token', () => {
  test('says so rather than making an unauthenticated request', async () => {
    const r = await runTool('ha-logs', ['core'], { env: { SUPERVISOR_TOKEN: '' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SUPERVISOR_TOKEN not set/);
  });
});

describe('an unknown flag', () => {
  test('is rejected instead of being read as a log source', async () => {
    const r = await runTool('ha-logs', ['--tail'], {});
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown option: --tail/);
  });
});
