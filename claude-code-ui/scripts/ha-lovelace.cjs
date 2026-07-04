#!/usr/bin/env node
/*
 * ha-lovelace — minimal Lovelace dashboard CLI over the HA WebSocket API.
 *
 * Lovelace config is only available over WebSocket (the REST /api/lovelace/*
 * endpoints return 404 on modern HA). This helper authenticates with
 * SUPERVISOR_TOKEN — the same token ha-ws-client uses successfully — and runs
 * the lovelace/* WebSocket commands.
 *
 *   ha-lovelace list                       # list storage-mode dashboards
 *   ha-lovelace get [url_path]             # get a dashboard config (default if omitted)
 *   ha-lovelace save <file|-> [url_path]   # save config from a JSON file or stdin
 *   ha-lovelace create <url_path> <title> [--icon mdi:x] [--no-sidebar] [--admin]
 *                                          # create a new empty storage-mode dashboard
 *   ha-lovelace delete <url_path>          # delete a storage-mode dashboard
 *
 * Notes:
 *  - YAML-mode dashboards cannot be saved over WebSocket; edit their .yaml files.
 *  - `save` expects a JSON document of the full dashboard config ({ "views": [...] }).
 *  - `create` makes the dashboard (url_path must contain a hyphen, e.g. "my-room");
 *    then `save <file> <url_path>` writes its views. New dashboards start empty.
 */
const WebSocket = require('ws');
const fs = require('fs');

const TOKEN = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
const WS_URL = 'ws://supervisor/core/api/websocket';

const [, , cmd, ...rest] = process.argv;

function usage() {
  console.error('Usage: ha-lovelace <list | get [url_path] | save <file|-> [url_path] | ' +
    'create <url_path> <title> [--icon mdi:x] [--no-sidebar] [--admin] | delete <url_path>>');
  process.exit(2);
}

if (!cmd) usage();
if (!TOKEN) { console.error('Error: no SUPERVISOR_TOKEN or HA_TOKEN in environment'); process.exit(1); }

const ws = new WebSocket(WS_URL);
let nextId = 1;
// Per-request-id response handlers, so multi-step commands (delete) can chain.
const handlers = new Map();

function send(obj, onResult) {
  const id = nextId++;
  if (onResult) handlers.set(id, onResult);
  ws.send(JSON.stringify({ ...obj, id }));
  return id;
}

// Default single-shot handler: print the result JSON and exit.
function printAndExit(result) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  if (msg.type === 'auth_required') {
    ws.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
  } else if (msg.type === 'auth_invalid') {
    console.error('Error: authentication failed —', msg.message || 'auth_invalid');
    process.exit(1);
  } else if (msg.type === 'auth_ok') {
    runCommand();
  } else if (msg.type === 'result') {
    if (!msg.success) {
      console.error('Error:', JSON.stringify(msg.error || {}));
      process.exit(1);
    }
    const handler = handlers.get(msg.id) || printAndExit;
    handlers.delete(msg.id);
    handler(msg.result);
  }
});

ws.on('error', (e) => { console.error('WebSocket error:', e.message); process.exit(1); });

function runCommand() {
  if (cmd === 'list') {
    send({ type: 'lovelace/dashboards/list' });

  } else if (cmd === 'get') {
    const urlPath = rest[0];
    const m = { type: 'lovelace/config', force: true };
    if (urlPath) m.url_path = urlPath;
    send(m);

  } else if (cmd === 'save') {
    const file = rest[0];
    const urlPath = rest[1];
    if (!file) usage();
    let raw;
    try {
      raw = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (e) {
      console.error('Error reading config:', e.message);
      process.exit(1);
    }
    let config;
    try {
      config = JSON.parse(raw);
    } catch (e) {
      console.error('Error: config must be valid JSON —', e.message);
      process.exit(1);
    }
    const m = { type: 'lovelace/config/save', config };
    if (urlPath) m.url_path = urlPath;
    send(m);

  } else if (cmd === 'create') {
    // create <url_path> <title> [--icon mdi:x] [--no-sidebar] [--admin]
    const urlPath = rest[0];
    const title = rest[1];
    if (!urlPath || !title) usage();
    if (!urlPath.includes('-')) {
      console.error('Error: url_path must contain a hyphen (e.g. "my-room")');
      process.exit(1);
    }
    const m = {
      type: 'lovelace/dashboards/create',
      url_path: urlPath,
      title,
      mode: 'storage',
      show_in_sidebar: !rest.includes('--no-sidebar'),
      require_admin: rest.includes('--admin'),
    };
    const iconIdx = rest.indexOf('--icon');
    if (iconIdx !== -1 && rest[iconIdx + 1]) m.icon = rest[iconIdx + 1];
    send(m);

  } else if (cmd === 'delete') {
    // Delete needs the dashboard_id, but url_path is what humans/agents know —
    // list the dashboards, resolve the id, then delete.
    const urlPath = rest[0];
    if (!urlPath) usage();
    send({ type: 'lovelace/dashboards/list' }, (dashboards) => {
      const match = (dashboards || []).find((d) => d.url_path === urlPath);
      if (!match) {
        console.error(`Error: no storage-mode dashboard with url_path "${urlPath}"`);
        process.exit(1);
      }
      send({ type: 'lovelace/dashboards/delete', dashboard_id: match.id }, () => {
        console.log(JSON.stringify({ deleted: urlPath, dashboard_id: match.id }, null, 2));
        process.exit(0);
      });
    });

  } else {
    usage();
  }
}
