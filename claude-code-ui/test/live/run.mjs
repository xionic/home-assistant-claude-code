#!/usr/bin/env node
/*
 * Live smoke test against the running app on a real Home Assistant.
 *
 * Everything else in this suite runs against fakes. This is the part that can
 * only be answered on the real thing: does the Supervisor token actually
 * authenticate, do the HA tools reach a real instance, is the log endpoint still
 * where we think it is.
 *
 *   npm run test:live                  read-only checks
 *   npm run test:live -- --with-agent  also runs one real agent turn (spends tokens)
 *   npm run test:live -- --mutating    also exercises the persistence path (writes
 *                                      to the live conversation)
 *
 * The app's container IP is on Docker's internal network, so requests go through
 * SSH to the HA host. Inside the container itself, pass --local.
 *
 * Requires the `debug` app option to be on — without it the diagnostic routes
 * are not registered at all and every probe below returns the SPA.
 *
 * Configuration (all optional, these are the defaults):
 *   HA_SSH_HOST=192.168.1.10  HA_SSH_PORT=222  HA_SSH_USER=hassio
 *   HA_SSH_KEY=~/.ssh/ha_claude  HA_ADDON_SLUG=local_claude-code-ui
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const WITH_AGENT = argv.includes('--with-agent');
const MUTATING = argv.includes('--mutating');
const LOCAL = argv.includes('--local');

const CFG = {
  host: process.env.HA_SSH_HOST || '192.168.1.10',
  port: process.env.HA_SSH_PORT || '222',
  user: process.env.HA_SSH_USER || 'hassio',
  key: process.env.HA_SSH_KEY || path.join(os.homedir(), '.ssh', 'ha_claude'),
  slug: process.env.HA_ADDON_SLUG || 'local_claude-code-ui',
};

const results = [];
let base = null;

const c = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', yellow: '\x1b[33m', reset: '\x1b[0m' };

/** Run a shell command on the HA host (or here, with --local). */
async function sh(command, { timeout = 60000 } = {}) {
  if (LOCAL) {
    const { stdout } = await execFileAsync('bash', ['-lc', command], { timeout, maxBuffer: 8 << 20 });
    return stdout;
  }
  const args = [
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-i', CFG.key, '-p', String(CFG.port), `${CFG.user}@${CFG.host}`, command,
  ];
  const { stdout } = await execFileAsync('ssh', args, { timeout, maxBuffer: 8 << 20 });
  return stdout;
}

/**
 * Run a command inside the app container.
 *
 * The `$` escaping matters: the command passes through the HA host's shell on
 * its way to `docker exec`, which would otherwise expand `$SUPERVISOR_TOKEN`
 * there — where it does not exist — and send an unauthenticated request.
 */
function inContainer(command) {
  if (LOCAL) return sh(command);
  const quoted = JSON.stringify(command).replaceAll('$', '\\$');
  return sh(`sudo docker exec app_${CFG.slug} bash -lc ${quoted}`);
}

async function getJson(pathname, { timeout = 60000 } = {}) {
  const url = `${base}${pathname}`;
  const body = await sh(`curl -s -m ${Math.floor(timeout / 1000)} ${JSON.stringify(url)}`, { timeout: timeout + 10000 });
  try {
    return JSON.parse(body);
  } catch {
    const head = body.slice(0, 120).replace(/\s+/g, ' ');
    if (/<!doctype|<html/i.test(body)) {
      throw new Error(`${pathname} returned the app, not JSON — is the \`debug\` option on?`);
    }
    throw new Error(`${pathname} did not return JSON: ${head}`);
  }
}

async function check(name, fn) {
  process.stdout.write(`${c.dim}·${c.reset} ${name} … `);
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`${c.green}ok${c.reset}${detail ? ` ${c.dim}${detail}${c.reset}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`${c.red}FAILED${c.reset}\n    ${String(e.message || e).split('\n').join('\n    ')}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(`\nLive smoke test — ${LOCAL ? 'inside the container' : `${CFG.user}@${CFG.host}:${CFG.port}`}\n`);

  // ── Reachability ───────────────────────────────────────────────────────────
  let info;
  await check('the app is installed and running', async () => {
    const raw = await sh(`bash -lc 'ha apps info ${CFG.slug} --raw-json'`);
    info = JSON.parse(raw).data;
    assert(info.state === 'started', `app state is ${info.state}`);
    base = `http://${info.ip_address}:7681`;
    return `v${info.version} at ${info.ip_address}`;
  });

  if (!base) {
    console.log(`\n${c.red}Cannot reach the app — nothing else can run.${c.reset}\n`);
    process.exit(1);
  }

  await check('the debug option is on (diagnostics are registered)', async () => {
    assert(info.options?.debug === true,
      'set `debug: true` in the app Configuration tab and restart — the /diag routes do not exist otherwise');
  });

  // ── Authentication and the HA tools ────────────────────────────────────────
  await check('/diag says the Supervisor token authenticates everything', async () => {
    const diag = await getJson('/diag', { timeout: 120000 });
    assert(diag.env.has_SUPERVISOR_TOKEN, 'no SUPERVISOR_TOKEN in the container');
    const failed = Object.entries(diag.tests)
      .filter(([, t]) => t.ok === false)
      .map(([k]) => k);
    assert(failed.length === 0, `these probes failed: ${failed.join(', ')}`);
    assert(diag.tests.rest_api_root.stdout.trim() === '200',
      `Core REST answered ${diag.tests.rest_api_root.stdout}`);
    return `${Object.keys(diag.tests).length} probes`;
  });

  await check('no stale MCP server is persisted in ~/.claude.json', async () => {
    const diag = await getJson('/diag', { timeout: 120000 });
    const mcp = diag.tests.claude_json_mcp.stdout || '';
    if (!mcp.trim()) return 'no .claude.json yet';
    const parsed = JSON.parse(mcp);
    assert(parsed.global_mcpServers.length === 0, `global: ${parsed.global_mcpServers.join(', ')}`);
    for (const [proj, servers] of Object.entries(parsed.project_mcpServers)) {
      assert(servers.length === 0, `${proj}: ${servers.join(', ')}`);
    }
  });

  await check('ha-tools lists every subcommand', async () => {
    const out = await inContainer('ha-tools --help');
    for (const sub of ['timeline', 'history', 'stats', 'logs', 'automation', 'config-check', 'reload', 'lovelace', 'ws']) {
      assert(new RegExp(`\\b${sub}\\b`).test(out), `--help never mentions ${sub}`);
    }
  });

  await check('ha-tools ws reaches the live instance', async () => {
    const out = await inContainer('ha-ws-client config 2>&1 | head -c 400');
    assert(!/error|unauthor/i.test(out), out.trim());
  });

  await check('ha-logs reads the real Core log', async () => {
    const out = await inContainer('ha-logs core -n 20 2>&1 | head -c 2000');
    assert(!/returned HTTP/.test(out), out.trim().split('\n')[0]);
    assert(!/^404: Not Found/m.test(out), 'the endpoint moved and the body is being printed as log content');
    assert(out.trim().length > 0, 'the Core log came back empty');
    return `${out.split('\n').length} lines`;
  });

  await check('ha-tools config-check validates the live configuration', async () => {
    const out = await inContainer('ha-tools config-check');
    const parsed = JSON.parse(out);
    assert(parsed.result === 'valid', `config is ${parsed.result}: ${parsed.errors}`);
  });

  await check('ha-tools automation list returns real automations', async () => {
    const parsed = JSON.parse(await inContainer('ha-tools automation list'));
    assert(typeof parsed.count === 'number', 'no count in the response');
    assert(parsed.timezone && parsed.timezone !== 'UTC',
      `timezone reported as ${parsed.timezone} — the container clock is UTC, so this should be your HA timezone`);
    return `${parsed.count} automations, ${parsed.timezone}`;
  });

  await check('ha-timeline reports times in the Home Assistant timezone', async () => {
    // ha-ws-client's `states` prints a human summary, so ask Core directly for a
    // sample entity — this check is about ha-timeline's clock, not about states.
    const entity = (await inContainer(
      'curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states ' +
      "| jq -r '[.[].entity_id | select(startswith(\"light.\") or startswith(\"binary_sensor.\"))][0] // empty'"
    )).trim();
    if (!entity) return 'no light/binary_sensor to sample';
    const out = await inContainer(`ha-timeline ${entity} --days 7 --format json`);
    const parsed = JSON.parse(out);
    assert(parsed.timezone, 'no timezone in the output');
    for (const ev of parsed.events.slice(0, 5)) {
      assert(/[+-]\d{2}:\d{2}$/.test(ev.time), `timestamp without an explicit offset: ${ev.time}`);
    }
    return `${entity}: ${parsed.event_count} events`;
  });

  await check('ha-lovelace lists dashboards over the WebSocket API', async () => {
    const out = await inContainer('ha-lovelace list');
    const parsed = JSON.parse(out);
    assert(Array.isArray(parsed), 'expected an array of dashboards');
    return `${parsed.length} dashboards`;
  });

  // ── Sessions and conversation ──────────────────────────────────────────────
  await check('the session store is readable and titled', async () => {
    const list = await getJson('/diag/sesslist');
    assert(Array.isArray(list.sessions), 'no session list');
    assert(list.sessions.every((s) => s.title), 'a session came back with no title');
    return `${list.sessions.length} sessions, active ${list.active || 'none'}`;
  });

  await check('the active conversation parses', async () => {
    const conv = await getJson('/diag/conv');
    return `${conv.count} items`;
  });

  await check('auto-continue state is coherent', async () => {
    const ac = await getJson('/diag/autocontinue');
    assert(typeof ac.enabled === 'boolean', 'no enabled flag');
    if (ac.pending) assert(ac.timerArmed, 'a resume is pending but no timer is armed');
    return `${ac.enabled ? 'on' : 'off'}, ${ac.subscription ? 'subscription' : 'api-key'} auth`;
  });

  // ── Optional, costed ───────────────────────────────────────────────────────
  if (WITH_AGENT) {
    await check('a real agent turn completes', async () => {
      const q = encodeURIComponent('Reply with the single word: ok');
      const out = await getJson(`/diag/query?q=${q}`, { timeout: 180000 });
      const err = out.events.find((e) => e.error);
      assert(!err, `agent error: ${err?.error}`);
      const result = out.events.find((e) => e.result);
      assert(result, 'the run produced no result event');
      assert(result.result.subtype === 'success', `result was ${result.result.subtype}`);
      const init = out.events.find((e) => e.init);
      assert(!init?.init.mcp_servers?.length, `an MCP server loaded: ${JSON.stringify(init.init.mcp_servers)}`);
      return `${result.result.turns} turn(s), $${(result.result.cost || 0).toFixed(4)}`;
    });
  } else {
    console.log(`${c.dim}·${c.reset} a real agent turn ${c.yellow}skipped${c.reset} ${c.dim}(--with-agent spends tokens)${c.reset}`);
  }

  if (MUTATING) {
    await check('one turn round-trips through the persistence path', async () => {
      const before = await getJson('/diag/conv');
      const out = await getJson('/diag/feed?q=Say%20hello%20in%20three%20words.', { timeout: 180000 });
      assert(out.count > before.count, 'the transcript did not grow');
      return `${before.count} → ${out.count} items`;
    });
  } else {
    console.log(`${c.dim}·${c.reset} the persistence path ${c.yellow}skipped${c.reset} ${c.dim}(--mutating writes to the live conversation)${c.reset}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? ` — ${c.red}${failed.length} failed${c.reset}\n` : `\n`));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n${c.red}Live run could not start:${c.reset} ${e.message}`);
  console.error(`${c.dim}Check HA_SSH_HOST/PORT/USER/KEY, or pass --local when running inside the container.${c.reset}\n`);
  process.exit(1);
});
