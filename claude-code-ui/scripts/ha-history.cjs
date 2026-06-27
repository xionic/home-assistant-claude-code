#!/usr/bin/env node
/*
 * ha-history — state-change history over a date range via the HA WebSocket API.
 *
 * Wraps `history/history_during_period`. The third-party ha-ws-client `history`
 * only returns a fixed recent window and REST history needs `date` math that
 * BusyBox can't do, so compute the range here in Node.
 *
 *   ha-history <entity_id> [--days N] [--from <ISO|YYYY-MM-DD>] [--to <ISO>] [--full]
 *
 *   ha-history sensor.temperature --days 7
 *   ha-history sensor.temperature --from 2026-06-10 --to 2026-06-11 --full
 *
 * By default attributes are omitted for brevity (state + timestamp only); pass
 * --full to include attributes. Output is the raw HA result: an object keyed by
 * entity_id whose value is an array of state points. Empty array = no recorded
 * changes in the window.
 */
const WebSocket = require('ws');

const TOKEN = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
const WS_URL = 'ws://supervisor/core/api/websocket';

function usage() {
  console.error('Usage: ha-history <entity_id> [--days N] [--from <ISO|YYYY-MM-DD>] [--to <ISO>] [--full]');
  process.exit(2);
}

const args = process.argv.slice(2);
const entity = args[0];
if (!entity || entity.startsWith('-')) usage();

let from, to, days, full = false;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--from') from = args[++i];
  else if (a === '--to') to = args[++i];
  else if (a === '--days') days = parseFloat(args[++i]);
  else if (a === '--full') full = true;
  else if (a === '-h' || a === '--help') usage();
  else { console.error('Unknown argument: ' + a); usage(); }
}
if (!TOKEN) { console.error('Error: no SUPERVISOR_TOKEN or HA_TOKEN in environment'); process.exit(1); }

function toISO(v) {
  const d = new Date(v);
  if (isNaN(d.getTime())) { console.error('Error: invalid date —', v); process.exit(1); }
  return d.toISOString();
}

const now = Date.now();
const startISO = from ? toISO(from)
  : new Date(now - (days && days > 0 ? days : 1) * 86400000).toISOString();
const endISO = to ? toISO(to) : null;

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
    const m = {
      id: nextId++,
      type: 'history/history_during_period',
      start_time: startISO,
      entity_ids: [entity],
      minimal_response: !full,
      no_attributes: !full,
      significant_changes_only: false,
    };
    if (endISO) m.end_time = endISO;
    send(m);
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
