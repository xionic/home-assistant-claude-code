#!/usr/bin/env node
/*
 * ha-stats — long-term statistics over a date range via the HA WebSocket API.
 *
 * Wraps `recorder/statistics_during_period`, which the third-party ha-ws-client
 * binary exposes only for a fixed recent window. Compute timestamps in Node so
 * we avoid BusyBox `date` (no -d/-v flags on this Alpine image).
 *
 *   ha-stats <entity_id> [--days N] [--from <ISO|YYYY-MM-DD>] [--to <ISO>]
 *                        [--period 5minute|hour|day|week|month]
 *
 *   ha-stats sensor.energy_cost --days 14            # last 14 days, hourly
 *   ha-stats sensor.energy_cost --from 2026-06-01 --to 2026-06-15 --period day
 *
 * Output is the raw HA result: an object keyed by statistic_id whose value is an
 * array of buckets ({ start, end, mean, min, max, sum, state, change, ... }).
 * An empty array means no recorded statistics in that window.
 */
const WebSocket = require('ws');

const TOKEN = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
const WS_URL = 'ws://supervisor/core/api/websocket';
const VALID_PERIODS = new Set(['5minute', 'hour', 'day', 'week', 'month']);

function usage() {
  console.error('Usage: ha-stats <entity_id> [--days N] [--from <ISO|YYYY-MM-DD>] [--to <ISO>] [--period 5minute|hour|day|week|month]');
  process.exit(2);
}

const args = process.argv.slice(2);
const entity = args[0];
if (!entity || entity.startsWith('-')) usage();

let from, to, days, period = 'hour';
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--from') from = args[++i];
  else if (a === '--to') to = args[++i];
  else if (a === '--days') days = parseFloat(args[++i]);
  else if (a === '--period') period = args[++i];
  else if (a === '-h' || a === '--help') usage();
  else { console.error('Unknown argument: ' + a); usage(); }
}
if (!VALID_PERIODS.has(period)) { console.error('Error: invalid --period:', period); usage(); }
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
      type: 'recorder/statistics_during_period',
      start_time: startISO,
      statistic_ids: [entity],
      period,
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
