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
 * The /diag checks also need a Home Assistant **admin's** long-lived access token.
 * Without one they are skipped, not failed, and the rest of the suite still runs:
 *
 *   prsecret Home-assistant-token-nick -- npm run test:live
 *   HA_API_TOKEN=<token> npm run test:live
 *
 * Configuration (all optional, these are the defaults):
 *   HA_SSH_HOST=192.168.1.10  HA_SSH_PORT=222  HA_SSH_USER=hassio
 *   HA_SSH_KEY=~/.ssh/ha_claude  HA_ADDON_SLUG=local_claude-code-ui
 *   HA_API_TOKEN / HOME_ASSISTANT_TOKEN_NICK  (no default — /diag checks skip)
 */
import { execFile, spawn } from 'node:child_process';
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

/**
 * /diag now requires a Home Assistant admin's long-lived access token.
 *
 * HOME_ASSISTANT_TOKEN_NICK is the name privd delivers the enrolled secret under,
 * so `prsecret Home-assistant-token-nick -- npm run test:live` needs no plumbing.
 * With no token the /diag checks are skipped rather than failed — a missing
 * credential is a configuration state, not a regression.
 */
const HA_TOKEN = process.env.HA_API_TOKEN || process.env.HOME_ASSISTANT_TOKEN_NICK || '';

const results = [];
let base = null;

const c = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', yellow: '\x1b[33m', reset: '\x1b[0m' };

/** How the command is spelled, locally or over SSH to the HA host. */
function argvFor(command) {
  if (LOCAL) return ['bash', ['-lc', command]];
  return ['ssh', [
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-i', CFG.key, '-p', String(CFG.port), `${CFG.user}@${CFG.host}`, command,
  ]];
}

/**
 * Run a shell command on the HA host (or here, with --local).
 *
 * `stdin` is piped in rather than interpolated into the command, so a secret sent
 * this way never appears in a process's arguments — visible to anyone who can run
 * `ps` on the HA host — nor in an error message that echoes the command.
 */
async function sh(command, { timeout = 60000, stdin = null } = {}) {
  const [cmd, args] = argvFor(command);

  if (stdin === null) {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 8 << 20 });
    return stdout;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new Error(`exit ${code}: ${(err || out).slice(0, 300)}`));
    });
    child.stdin.end(stdin);
  });
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
  // The token travels as a curl config file on stdin, so it stays out of argv.
  const body = await sh(`curl -s -m ${Math.floor(timeout / 1000)} --config - ${JSON.stringify(url)}`, {
    timeout: timeout + 10000,
    stdin: `header = "Authorization: Bearer ${HA_TOKEN}"\n`,
  });

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    const head = body.slice(0, 120).replace(/\s+/g, ' ');
    if (/<!doctype|<html/i.test(body)) {
      throw new Error(`${pathname} returned the app, not JSON — is the \`debug\` option on?`);
    }
    throw new Error(`${pathname} did not return JSON: ${head}`);
  }

  // The guard answers in JSON too, so say what happened rather than letting the
  // caller trip over a missing field.
  if (parsed?.error === 'unauthorized' || parsed?.error === 'forbidden') {
    throw new Error(`${pathname} refused the token (${parsed.error}) — it must be a Home Assistant ` +
      'long-lived access token belonging to an admin user');
  }
  if (parsed?.error === 'auth_unavailable') {
    throw new Error(`${pathname} could not validate the token — the app could not reach Home Assistant`);
  }
  return parsed;
}

/**
 * A check that needs /diag, and so needs a token. Without one it is skipped, in
 * the same shape as the --with-agent and --mutating skips below.
 */
async function diagCheck(name, fn) {
  if (!HA_TOKEN) {
    console.log(`${c.dim}·${c.reset} ${name} ${c.yellow}skipped${c.reset} ` +
      `${c.dim}(no HA_API_TOKEN / HOME_ASSISTANT_TOKEN_NICK — /diag needs an admin token)${c.reset}`);
    return;
  }
  return check(name, fn);
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
  await diagCheck('/diag says the Supervisor token authenticates everything', async () => {
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

  await diagCheck('no stale MCP server is persisted in ~/.claude.json', async () => {
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
    // The endpoint answering "valid" is not on its own an all-clear: per-entity
    // errors only reach the Core log. A clean instance must report neither.
    assert(!parsed.platform_errors,
      `entities are being dropped: ${JSON.stringify(parsed.platform_errors)}`);
    assert(!parsed.log_scan,
      `the check could not read the Core log, so it proved less than it looks: ${parsed.log_scan}`);
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
  await diagCheck('the session store is readable and titled', async () => {
    const list = await getJson('/diag/sesslist');
    assert(Array.isArray(list.sessions), 'no session list');
    assert(list.sessions.every((s) => s.title), 'a session came back with no title');
    return `${list.sessions.length} sessions, active ${list.active || 'none'}`;
  });

  await diagCheck('the active conversation parses', async () => {
    const conv = await getJson('/diag/conv');
    return `${conv.count} items`;
  });

  await diagCheck('auto-continue state is coherent', async () => {
    const ac = await getJson('/diag/autocontinue');
    assert(typeof ac.enabled === 'boolean', 'no enabled flag');
    if (ac.pending) assert(ac.timerArmed, 'a resume is pending but no timer is armed');
    return `${ac.enabled ? 'on' : 'off'}, ${ac.subscription ? 'subscription' : 'api-key'} auth`;
  });

  // ── Optional, costed ───────────────────────────────────────────────────────
  if (WITH_AGENT) {
    await diagCheck('a real agent turn completes', async () => {
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
    await diagCheck('one turn round-trips through the persistence path', async () => {
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
