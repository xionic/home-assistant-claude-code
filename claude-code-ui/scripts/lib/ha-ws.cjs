/*
 * ha-ws — shared Home Assistant WebSocket client for the ha-tools helpers.
 *
 * Every WebSocket helper in this app used to carry its own copy of the same
 * connect → auth_required → auth → auth_ok → send → match result dance. This is
 * that dance, once: `connect()` resolves only after auth_ok, and the client it
 * hands back turns each command into a promise keyed on the message id, so
 * multi-step commands (e.g. resolve a dashboard id, then delete it) are plain
 * awaits instead of nested callbacks.
 *
 *   const ws = await connect();
 *   const dashboards = await ws.send({ type: 'lovelace/dashboards/list' });
 *
 * Auth is $SUPERVISOR_TOKEN (or $HA_TOKEN) — the token the Supervisor injects
 * into this app's environment. HA_WS_URL overrides the endpoint for testing
 * outside the app container.
 */
const WebSocket = require('ws');

const WS_URL = process.env.HA_WS_URL || 'ws://supervisor/core/api/websocket';

/** Print a message to stderr and exit non-zero. */
function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/** Print a usage line to stderr and exit 2 (the convention across these tools). */
function usage(line) {
  console.error(`Usage: ${line}`);
  process.exit(2);
}

/** Pretty-print a result as JSON on stdout — the output shape all helpers share. */
function printJSON(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** Parse a date the helpers accept (ISO, or YYYY-MM-DD meaning UTC midnight). */
function toISO(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) die(`Error: invalid date — ${value}`);
  return d.toISOString();
}

/**
 * Resolve --from/--to/--days into a start/end pair. Defaults to the last day.
 * end is null when --to was omitted, meaning "up to now" to HA.
 */
function timeRange({ from, to, days }) {
  return {
    startISO: from
      ? toISO(from)
      : new Date(Date.now() - (days && days > 0 ? days : 1) * 86400000).toISOString(),
    endISO: to ? toISO(to) : null,
  };
}

/**
 * Open an authenticated connection. Resolves with:
 *   send(message)  → Promise of the command's `result` (rejects on error)
 *   close()        → close the socket
 */
function connect() {
  const token = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
  if (!token) die('Error: no SUPERVISOR_TOKEN or HA_TOKEN in environment');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const pending = new Map();
    let nextId = 1;
    let settled = false;

    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (msg.type === 'auth_invalid') {
        fail(new Error(`authentication failed — ${msg.message || 'auth_invalid'}`));
        ws.close();
      } else if (msg.type === 'auth_ok') {
        settled = true;
        resolve({
          send(message) {
            const id = nextId++;
            return new Promise((res, rej) => {
              pending.set(id, { res, rej });
              ws.send(JSON.stringify({ ...message, id }));
            });
          },
          close() {
            ws.close();
          },
        });
      } else if (msg.type === 'result') {
        const handler = pending.get(msg.id);
        if (!handler) return;
        pending.delete(msg.id);
        if (msg.success) handler.res(msg.result);
        else handler.rej(new Error(JSON.stringify(msg.error || {})));
      }
    });

    ws.on('error', (e) => fail(new Error(`WebSocket error: ${e.message}`)));

    // A close mid-command would otherwise hang the process on an unsettled
    // promise until Node ran out of work and exited silently with status 0.
    ws.on('close', () => {
      fail(new Error('connection closed before authentication completed'));
      for (const { rej } of pending.values()) {
        rej(new Error('connection closed before a result arrived'));
      }
      pending.clear();
    });
  });
}

/**
 * Run a subcommand against an authenticated connection, turning any thrown
 * error into the one-line `Error: …` + exit 1 these tools have always used.
 */
async function run(fn) {
  let ws;
  try {
    ws = await connect();
    await fn(ws);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  ws.close();
}

module.exports = { connect, run, die, usage, printJSON, toISO, timeRange };
