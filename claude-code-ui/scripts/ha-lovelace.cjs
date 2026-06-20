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
 *
 * Notes:
 *  - YAML-mode dashboards cannot be saved over WebSocket; edit their .yaml files.
 *  - `save` expects a JSON document of the full dashboard config ({ "views": [...] }).
 */
const WebSocket = require('ws');
const fs = require('fs');

const TOKEN = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
const WS_URL = 'ws://supervisor/core/api/websocket';

const [, , cmd, ...rest] = process.argv;

function usage() {
  console.error('Usage: ha-lovelace <list | get [url_path] | save <file|-> [url_path]>');
  process.exit(2);
}

if (!cmd) usage();
if (!TOKEN) { console.error('Error: no SUPERVISOR_TOKEN or HA_TOKEN in environment'); process.exit(1); }

const ws = new WebSocket(WS_URL);
let nextId = 1;

function send(obj) { ws.send(JSON.stringify(obj)); }

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  if (msg.type === 'auth_required') {
    send({ type: 'auth', access_token: TOKEN });
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
    console.log(JSON.stringify(msg.result, null, 2));
    process.exit(0);
  }
});

ws.on('error', (e) => { console.error('WebSocket error:', e.message); process.exit(1); });

function runCommand() {
  if (cmd === 'list') {
    send({ id: nextId++, type: 'lovelace/dashboards/list' });

  } else if (cmd === 'get') {
    const urlPath = rest[0];
    const m = { id: nextId++, type: 'lovelace/config', force: true };
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
    const m = { id: nextId++, type: 'lovelace/config/save', config };
    if (urlPath) m.url_path = urlPath;
    send(m);

  } else {
    usage();
  }
}
