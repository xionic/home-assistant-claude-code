#!/usr/bin/env node
/*
 * ha-tools (Node half) — the Home Assistant subcommands.
 *
 * Not run directly: `ha-tools.sh` dispatches here (and to `ha-logs.sh` for
 * `logs`), so each of these is reachable as either `ha-tools <cmd> …` or its own
 * name (`ha-history`, `ha-stats`, `ha-lovelace`, `ha-timeline`). Connection and
 * auth live in lib/ha-ws.cjs; time formatting in lib/ha-time.cjs; the handful of
 * REST-only endpoints in lib/ha-rest.cjs.
 *
 *   history      <entity_id> [--days N] [--from] [--to] [--full] [--format]
 *   stats        <entity_id> [--days N] [--from] [--to] [--period] [--format]
 *   timeline     <entity_id…> [--days N] [--from] [--to] [--between HH:MM-HH:MM]
 *   lovelace     <list | get | save | create | delete> …
 *   automation   <list | show | yaml> …
 *   config-check
 *   reload       [domain]
 *   trace-watch  <automation> [--timeout 15m] [--interval 10s]
 *
 * Two conventions hold across all of them, because the consumer is an agent
 * reading stdout rather than a human squinting at it:
 *   - Times print in Home Assistant's own timezone with an explicit offset
 *     (the container clock is UTC and is NOT what the user means by "local").
 *     `--utc` opts out. Epoch floats never reach the output.
 *   - An empty result is an empty list, never null, and a real failure is a
 *     non-zero exit with a message — the two must never look alike.
 *
 * $HA_TOOLS_CMD is how the user spelled the command; it's echoed back in usage
 * messages so `ha-history --help` doesn't answer as `ha-tools history`.
 */
const fs = require('fs');
const path = require('path');
const { run, die, usage, printJSON, timeRange } = require('./lib/ha-ws.cjs');
const { core } = require('./lib/ha-rest.cjs');
const { parseDuration, parseWindow, clock, inWindow, toMillis } = require('./lib/ha-time.cjs');

const [sub, ...args] = process.argv.slice(2);
const CMD = process.env.HA_TOOLS_CMD || `ha-tools ${sub || ''}`.trim();
const CONFIG_DIR = process.env.HA_CONFIG_DIR || '/config';

const VALID_PERIODS = new Set(['5minute', 'hour', 'day', 'week', 'month']);
const VALID_FORMATS = new Set(['json', 'tsv', 'text']);

const USAGE = {
  history: `${CMD} <entity_id> [--days N] [--from <ISO|YYYY-MM-DD>] [--to <ISO>] [--full] ` +
    `[--format json|tsv] [--utc]`,
  stats: `${CMD} <entity_id> [--days N] [--from <ISO|YYYY-MM-DD>] [--to <ISO>] ` +
    `[--period 5minute|hour|day|week|month] [--format json|tsv] [--utc]`,
  timeline: `${CMD} <entity_id> [entity_id…] [--days N] [--from <ISO|YYYY-MM-DD>] [--to <ISO>] ` +
    `[--between HH:MM-HH:MM] [--format text|tsv|json] [--utc]`,
  lovelace: `${CMD} <list | get [url_path] | save <file|-> [url_path] | ` +
    `create <url_path> <title> [--icon mdi:x] [--no-sidebar] [--admin] | delete <url_path>>`,
  automation: `${CMD} <list | show <entity_id|id> | yaml <entity_id|id>> [--utc]`,
  'config-check': `${CMD}`,
  reload: `${CMD} [domain]   (default: automation; 'all' reloads everything reloadable)`,
  'trace-watch': `${CMD} <entity_id|id> [--timeout 15m] [--interval 10s] [--format text|json] [--utc]`,
};

/* ---------------------------------------------------------------- arguments */

/**
 * Shared parser for the date-range commands. `accepts` names the extra flags a
 * command takes, so `--period` on history is rejected rather than silently
 * ignored — an ignored flag is an agent believing it filtered when it didn't.
 */
function parseRangeArgs(name, accepts = {}) {
  const entities = [];
  const opts = { full: false, period: 'hour', format: accepts.defaultFormat || 'json', utc: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') opts.from = args[++i];
    else if (a === '--to') opts.to = args[++i];
    else if (a === '--days') opts.days = parseFloat(args[++i]);
    else if (a === '--utc') opts.utc = true;
    else if (a === '--format') opts.format = args[++i];
    else if (a === '--full' && accepts.full) opts.full = true;
    else if (a === '--period' && accepts.period) opts.period = args[++i];
    else if (a === '--between' && accepts.between) opts.between = args[++i];
    else if (a === '-h' || a === '--help') usage(USAGE[name]);
    else if (a.startsWith('-')) {
      console.error(`Unknown argument: ${a}`);
      usage(USAGE[name]);
    } else entities.push(a);
  }

  if (entities.length === 0) usage(USAGE[name]);
  if (!accepts.multi && entities.length > 1) {
    console.error(`Error: ${name} takes one entity_id (got ${entities.length}) — ` +
      `use \`ha-tools timeline\` to correlate several entities`);
    usage(USAGE[name]);
  }
  if (!VALID_FORMATS.has(opts.format)) {
    console.error(`Error: invalid --format: ${opts.format}`);
    usage(USAGE[name]);
  }
  opts.entities = entities;
  opts.entity = entities[0];
  if (opts.between) {
    try {
      opts.window = parseWindow(opts.between);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      usage(USAGE[name]);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------- shared */

/**
 * The clock every command prints with: Home Assistant's configured timezone,
 * read from the running instance. The container is UTC, so trusting the local
 * clock here would silently shift every timestamp we report.
 */
async function haClock(ws, utc) {
  if (utc) return clock('UTC');
  try {
    const config = await ws.send({ type: 'get_config' });
    return clock(config?.time_zone || 'UTC');
  } catch {
    return clock('UTC');
  }
}

/**
 * Flatten a `history/history_during_period` response into plain rows.
 *
 * HA's shape is awkward: an object keyed by entity_id whose first element is a
 * full state object and whose later elements are compact ({s, lu}) — so anything
 * consuming it directly has to know both spellings. Everything downstream of
 * here works with {entity_id, ms, state} instead.
 */
function flattenHistory(result) {
  const rows = [];
  for (const [entityId, points] of Object.entries(result || {})) {
    for (const p of points || []) {
      const ms = toMillis(p.lu ?? p.last_updated ?? p.lc ?? p.last_changed);
      if (ms === null) continue;
      rows.push({ entity_id: p.entity_id || entityId, ms, state: p.s ?? p.state });
    }
  }
  return rows.sort((a, b) => a.ms - b.ms);
}

/** Resolve an entity_id, object_id, numeric id, or alias to one automation. */
async function resolveAutomation(ws, ref) {
  const states = await ws.send({ type: 'get_states' });
  const automations = (states || []).filter((s) => s.entity_id.startsWith('automation.'));
  const needle = String(ref).toLowerCase();

  const match = automations.find((s) =>
    s.entity_id.toLowerCase() === needle ||
    s.entity_id.toLowerCase() === `automation.${needle}` ||
    String(s.attributes?.id) === String(ref) ||
    String(s.attributes?.friendly_name || '').toLowerCase() === needle);

  if (!match) {
    throw new Error(
      `no automation matching "${ref}" — try \`ha-tools automation list\` ` +
      `(matched on entity_id, numeric id, or friendly name)`);
  }
  return {
    entity_id: match.entity_id,
    id: match.attributes?.id ? String(match.attributes.id) : null,
    alias: match.attributes?.friendly_name || null,
    state: match.state,
    last_triggered: match.attributes?.last_triggered || null,
  };
}

/* ----------------------------------------------------------------- commands */

// history — state changes over a date range (history/history_during_period).
// The ha-ws-client binary's `history` covers only a fixed recent window.
function history() {
  const opts = parseRangeArgs('history', { full: true });
  const { startISO, endISO } = timeRange(opts);

  return run(async (ws) => {
    const message = {
      type: 'history/history_during_period',
      start_time: startISO,
      entity_ids: [opts.entity],
      // Attributes dominate the output and are rarely the question; --full
      // puts them back.
      minimal_response: !opts.full,
      no_attributes: !opts.full,
      significant_changes_only: false,
    };
    if (endISO) message.end_time = endISO;
    const result = await ws.send(message);

    if (opts.format === 'json') {
      // Raw HA shape, unchanged — documented in SKILL.md and depended on.
      printJSON(result);
      return;
    }
    const c = await haClock(ws, opts.utc);
    printRows(flattenHistory(result), c, opts.format);
  });
}

// stats — long-term statistics over a date range
// (recorder/statistics_during_period).
function stats() {
  const opts = parseRangeArgs('stats', { period: true });
  if (!VALID_PERIODS.has(opts.period)) {
    console.error(`Error: invalid --period: ${opts.period}`);
    usage(USAGE.stats);
  }
  const { startISO, endISO } = timeRange(opts);

  return run(async (ws) => {
    const message = {
      type: 'recorder/statistics_during_period',
      start_time: startISO,
      statistic_ids: [opts.entity],
      period: opts.period,
    };
    if (endISO) message.end_time = endISO;
    const result = await ws.send(message);

    if (opts.format === 'json') {
      printJSON(result);
      return;
    }
    const c = await haClock(ws, opts.utc);
    console.log(['start', 'statistic_id', 'mean', 'min', 'max', 'sum', 'state', 'change'].join('\t'));
    for (const [statId, buckets] of Object.entries(result || {})) {
      for (const b of buckets || []) {
        const ms = toMillis(b.start);
        console.log([
          ms === null ? '' : c.stamp(ms), statId,
          b.mean ?? '', b.min ?? '', b.max ?? '', b.sum ?? '', b.state ?? '', b.change ?? '',
        ].join('\t'));
      }
    }
  });
}

/** Shared row printer for timeline/history flat output. */
function printRows(rows, c, format) {
  if (format === 'tsv') {
    console.log(['timestamp', 'entity_id', 'state'].join('\t'));
    for (const r of rows) console.log([c.stamp(r.ms), r.entity_id, r.state].join('\t'));
    return;
  }
  // Text: one row per event, column-aligned, with the zone stated once up top
  // so a reader never has to guess which clock these are on.
  const width = rows.reduce((w, r) => Math.max(w, r.entity_id.length), 0);
  const offset = rows.length ? c.offset(rows[0].ms) : '';
  console.log(`# times are ${c.timeZone}${offset ? ` (UTC${offset})` : ''}; ${rows.length} events`);
  for (const r of rows) {
    console.log(`${c.shortStamp(r.ms)}  ${r.entity_id.padEnd(width)}  ${r.state}`);
  }
}

// timeline — several entities' state changes merged onto one clock.
//
// Correlating entities against each other is the core automation-debugging
// move, and doing it by hand means fetching each entity separately, converting
// epoch floats, merging and sorting. That's plumbing, so it lives here.
function timeline() {
  const opts = parseRangeArgs('timeline', { between: true, multi: true, defaultFormat: 'text' });
  const { startISO, endISO } = timeRange(opts);

  return run(async (ws) => {
    const message = {
      type: 'history/history_during_period',
      start_time: startISO,
      entity_ids: opts.entities,
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    };
    if (endISO) message.end_time = endISO;

    const result = await ws.send(message);
    const c = await haClock(ws, opts.utc);
    const rows = flattenHistory(result).filter((r) => inWindow(c, r.ms, opts.window));

    if (opts.format === 'json') {
      printJSON({
        timezone: c.timeZone,
        entity_ids: opts.entities,
        start: startISO,
        end: endISO,
        between: opts.between || null,
        event_count: rows.length,
        events: rows.map((r) => ({
          time: c.stamp(r.ms),
          epoch_ms: r.ms,
          entity_id: r.entity_id,
          state: r.state,
        })),
      });
      return;
    }
    printRows(rows, c, opts.format);

    // Entities with no rows at all are worth calling out: "no events" and "you
    // typo'd the entity_id" look identical in a merged timeline otherwise.
    const seen = new Set(rows.map((r) => r.entity_id));
    const silent = opts.entities.filter((e) => !seen.has(e));
    if (silent.length) {
      console.error(`Note: no events in this window for ${silent.join(', ')} ` +
        `(entity may not exist, or may not have changed state)`);
    }
  });
}

// lovelace — dashboards. Storage-mode dashboard config is WebSocket-only; the
// REST /api/lovelace/* endpoints return 404 on modern HA.
function lovelace() {
  const [action, ...rest] = args;
  if (!action) usage(USAGE.lovelace);

  return run(async (ws) => {
    switch (action) {
      case 'list':
        printJSON(await ws.send({ type: 'lovelace/dashboards/list' }));
        return;

      case 'get': {
        const message = { type: 'lovelace/config', force: true };
        if (rest[0]) message.url_path = rest[0];
        printJSON(await ws.send(message));
        return;
      }

      case 'save': {
        const [file, urlPath] = rest;
        if (!file) usage(USAGE.lovelace);
        let raw;
        try {
          raw = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
        } catch (e) {
          die(`Error reading config: ${e.message}`);
        }
        let config;
        try {
          config = JSON.parse(raw);
        } catch (e) {
          die(`Error: config must be valid JSON — ${e.message}`);
        }
        const message = { type: 'lovelace/config/save', config };
        if (urlPath) message.url_path = urlPath;
        printJSON(await ws.send(message));
        return;
      }

      case 'create': {
        const [urlPath, title] = rest;
        if (!urlPath || !title) usage(USAGE.lovelace);
        if (!urlPath.includes('-')) {
          die('Error: url_path must contain a hyphen (e.g. "my-room")');
        }
        const message = {
          type: 'lovelace/dashboards/create',
          url_path: urlPath,
          title,
          mode: 'storage',
          show_in_sidebar: !rest.includes('--no-sidebar'),
          require_admin: rest.includes('--admin'),
        };
        const iconIdx = rest.indexOf('--icon');
        if (iconIdx !== -1 && rest[iconIdx + 1]) message.icon = rest[iconIdx + 1];
        printJSON(await ws.send(message));
        return;
      }

      case 'delete': {
        // Delete takes a dashboard_id, but url_path is what humans and agents
        // know — list first and resolve it.
        const urlPath = rest[0];
        if (!urlPath) usage(USAGE.lovelace);
        const dashboards = await ws.send({ type: 'lovelace/dashboards/list' });
        const match = (dashboards || []).find((d) => d.url_path === urlPath);
        if (!match) die(`Error: no storage-mode dashboard with url_path "${urlPath}"`);
        await ws.send({ type: 'lovelace/dashboards/delete', dashboard_id: match.id });
        printJSON({ deleted: urlPath, dashboard_id: match.id });
        return;
      }

      default:
        usage(USAGE.lovelace);
    }
  });
}

// automation — what HA actually has loaded, and what's on disk.
//
// After editing automations.yaml and reloading, the obvious check is "show me
// what HA now holds". `show` is that call. It reports which key spelling the
// config came back with, because HA moved from `trigger:`/`action:` to the
// plural `triggers:`/`actions:` and tools that only read one spelling report a
// perfectly healthy automation as empty.
function automation() {
  const [action, ...rest] = args;
  const utc = rest.includes('--utc');
  if (!action) usage(USAGE.automation);

  return run(async (ws) => {
    if (action === 'list') {
      const states = await ws.send({ type: 'get_states' });
      const c = await haClock(ws, utc);
      const rows = (states || [])
        .filter((s) => s.entity_id.startsWith('automation.'))
        .map((s) => ({
          entity_id: s.entity_id,
          id: s.attributes?.id ? String(s.attributes.id) : null,
          alias: s.attributes?.friendly_name || null,
          state: s.state,
          last_triggered: s.attributes?.last_triggered
            ? c.stamp(toMillis(s.attributes.last_triggered))
            : null,
        }))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
      printJSON({ timezone: c.timeZone, count: rows.length, automations: rows });
      return;
    }

    const ref = rest.find((a) => !a.startsWith('-'));
    if (!ref) usage(USAGE.automation);
    const found = await resolveAutomation(ws, ref);

    if (action === 'show') {
      let config = null;
      let source = null;
      try {
        const result = await ws.send({ type: 'automation/config', entity_id: found.entity_id });
        config = result?.config ?? result ?? null;
        source = 'websocket automation/config';
      } catch (e) {
        // Fall through to REST rather than reporting a guess at the cause.
        source = `websocket automation/config failed (${e.message})`;
      }

      const empty = (cfg) => !cfg || (!cfg.trigger && !cfg.triggers && !cfg.action && !cfg.actions);
      if (empty(config) && found.id) {
        try {
          config = await core(`config/automation/config/${found.id}`);
          source = 'rest config/automation/config (stored)';
        } catch (e) {
          die(`Error: could not read config for ${found.entity_id} — ${e.message}`);
        }
      }

      const count = (singular, plural) => {
        const value = config?.[plural] ?? config?.[singular];
        if (value === undefined || value === null) return 0;
        return Array.isArray(value) ? value.length : 1;
      };
      printJSON({
        entity_id: found.entity_id,
        id: found.id,
        alias: found.alias || config?.alias || null,
        state: found.state,
        source,
        // Which spelling HA used — the thing that silently breaks parsers.
        schema: config?.triggers || config?.actions ? 'plural' : 'singular',
        uses_blueprint: Boolean(config?.use_blueprint),
        summary: {
          triggers: count('trigger', 'triggers'),
          conditions: count('condition', 'conditions'),
          actions: count('action', 'actions'),
        },
        config,
      });
      return;
    }

    if (action === 'yaml') {
      if (!found.id) die(`Error: ${found.entity_id} has no id attribute — it isn't in automations.yaml`);
      const file = path.join(CONFIG_DIR, 'automations.yaml');
      let lines;
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
      } catch (e) {
        die(`Error reading ${file}: ${e.message}`);
      }

      // automations.yaml is a top-level list, so a block runs from its "- " line
      // to the line before the next one. Line-scanning beats a YAML parse here:
      // it preserves formatting and comments exactly as written on disk.
      const starts = [];
      lines.forEach((line, i) => {
        if (/^-\s/.test(line) || /^-$/.test(line.trimEnd())) starts.push(i);
      });
      const idPattern = new RegExp(`^\\s*(-\\s+)?id:\\s*['"]?${found.id}['"]?\\s*$`);
      const blockIdx = starts.findIndex((start, n) => {
        const end = starts[n + 1] ?? lines.length;
        return lines.slice(start, end).some((l) => idPattern.test(l));
      });
      if (blockIdx === -1) {
        die(`Error: no automation with id ${found.id} in ${file} ` +
          `(it may be defined in a package or a !include'd file)`);
      }
      const start = starts[blockIdx];
      let end = starts[blockIdx + 1] ?? lines.length;
      // The blank line separating two entries belongs to neither of them.
      while (end > start + 1 && lines[end - 1].trim() === '') end--;
      const width = String(end).length;
      console.log(`# ${file}, lines ${start + 1}-${end} — ${found.entity_id}`);
      for (let i = start; i < end; i++) {
        console.log(`${String(i + 1).padStart(width)}  ${lines[i]}`);
      }
      return;
    }

    usage(USAGE.automation);
  });
}

// config-check — validate the config HA would load. The safety step when
// hand-editing YAML, and REST-only (there is no WebSocket equivalent), which is
// why it used to mean hand-rolling a curl. Exits non-zero when invalid so a
// caller can branch on it without parsing.
async function configCheck() {
  if (args.some((a) => a === '-h' || a === '--help')) usage(USAGE['config-check']);
  let result;
  try {
    result = await core('config/core/check_config', { method: 'POST', timeoutMs: 120000 });
  } catch (e) {
    die(`Error: ${e.message}`);
  }
  printJSON(result);
  if (result?.result !== 'valid') process.exit(1);
}

// reload — pick up edited YAML without restarting HA.
const RELOAD_ALL = 'all';
async function reload() {
  if (args.some((a) => a === '-h' || a === '--help')) usage(USAGE.reload);
  const domain = args.find((a) => !a.startsWith('-')) || 'automation';
  const [callDomain, service] = domain === RELOAD_ALL
    ? ['homeassistant', 'reload_all']
    : [domain, 'reload'];

  try {
    await core(`services/${callDomain}/${service}`, { method: 'POST', body: {}, timeoutMs: 120000 });
  } catch (e) {
    die(`Error: reloading ${domain} failed — ${e.message}`);
  }
  printJSON({ reloaded: domain, service: `${callDomain}.${service}` });
}

// trace-watch — block until the automation actually fires, then report the
// trace.
//
// Verifying a changed trigger needs the trigger to genuinely fire;
// `automation.trigger` skips triggers and conditions, so it proves nothing about
// the thing you just edited. This polls the trace list rather than subscribing
// to automation_triggered, because a run blocked by its conditions still writes
// a trace — and "it fired but the condition stopped it" is usually the answer
// you're looking for.
function traceWatch() {
  const ref = args.find((a) => !a.startsWith('-'));
  if (!ref) usage(USAGE['trace-watch']);

  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const timeoutRaw = flag('--timeout', '15m');
  const intervalRaw = flag('--interval', '10s');
  let timeoutMs;
  let intervalMs;
  try {
    timeoutMs = parseDuration(timeoutRaw, '--timeout');
    intervalMs = parseDuration(intervalRaw, '--interval');
  } catch (e) {
    console.error(`Error: ${e.message}`);
    usage(USAGE['trace-watch']);
  }
  const format = flag('--format', 'text');
  const utc = args.includes('--utc');

  return run(async (ws) => {
    const found = await resolveAutomation(ws, ref);
    if (!found.id) die(`Error: ${found.entity_id} has no internal id, so it has no traces`);
    const c = await haClock(ws, utc);

    const listTraces = async () =>
      (await ws.send({ type: 'trace/list', domain: 'automation', item_id: found.id })) || [];
    const seen = new Set((await listTraces()).map((t) => t.run_id));
    const deadline = Date.now() + timeoutMs;

    // stderr, so stdout carries only the result the caller is waiting for.
    console.error(`Watching ${found.entity_id} for a new trace ` +
      `(${seen.size} existing, polling every ${intervalRaw}, giving up after ${timeoutRaw})…`);

    for (;;) {
      const traces = await listTraces();
      const fresh = traces
        .filter((t) => !seen.has(t.run_id))
        .sort((a, b) => (toMillis(a.timestamp?.start) ?? 0) - (toMillis(b.timestamp?.start) ?? 0));
      if (fresh.length) {
        const newest = fresh[fresh.length - 1];
        const detail = await ws.send({
          type: 'trace/get',
          domain: 'automation',
          item_id: found.id,
          run_id: newest.run_id,
        });
        printTrace(found, newest, detail, c, format);
        return;
      }
      if (Date.now() >= deadline) {
        console.error(`No new trace for ${found.entity_id} within the timeout — ` +
          `it has not fired. (Its triggers may never have occurred; this is not an error.)`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()) + 1)));
    }
  });
}

function printTrace(found, trace, detail, c, format) {
  const ms = toMillis(trace.timestamp?.start || detail?.timestamp?.start);
  // script_execution is HA's own verdict on the run: "finished" means it ran to
  // the end, "failed_conditions" means the conditions blocked it — the
  // distinction the whole watch exists to capture.
  const verdict = detail?.script_execution || trace.script_execution || 'unknown';
  const summary = {
    entity_id: found.entity_id,
    run_id: trace.run_id,
    time: ms === null ? null : c.stamp(ms),
    timezone: c.timeZone,
    script_execution: verdict,
    last_step: detail?.last_step || trace.last_step || null,
    error: detail?.error || trace.error || null,
    condition_blocked: verdict === 'failed_conditions',
  };
  if (format === 'json') {
    printJSON({ ...summary, trace: detail });
    return;
  }
  console.log(`${summary.time}  ${found.entity_id}  fired`);
  console.log(`  run_id:           ${summary.run_id}`);
  console.log(`  script_execution: ${verdict}${verdict === 'failed_conditions' ? '  (a condition blocked it)' : ''}`);
  if (summary.last_step) console.log(`  last_step:        ${summary.last_step}`);
  if (summary.error) console.log(`  error:            ${summary.error}`);
  console.log(`  full trace:       ha-ws-client trace-debug ${found.entity_id} ${summary.run_id}`);
}

/* --------------------------------------------------------------- dispatch */

const COMMANDS = {
  history,
  stats,
  timeline,
  lovelace,
  automation,
  'config-check': configCheck,
  reload,
  'trace-watch': traceWatch,
};

if (!COMMANDS[sub]) {
  console.error(`ha-tools: unknown subcommand '${sub || ''}' — expected one of: ` +
    `${Object.keys(COMMANDS).join(', ')}`);
  process.exit(2);
}

Promise.resolve(COMMANDS[sub]()).catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
