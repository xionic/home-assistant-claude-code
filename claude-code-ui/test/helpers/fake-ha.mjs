/*
 * fake-ha — a stand-in Home Assistant for the CLI tests: the WebSocket API
 * (auth handshake plus scripted command results) and the Supervisor's REST and
 * journald endpoints.
 *
 * The tools already honour HA_WS_URL / HA_SUPERVISOR_URL / HA_TOKEN "for testing
 * outside the app container", so nothing has to be stubbed at the module level —
 * these are the real scripts talking real protocol to a fake instance.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '..', '..');
const SCRIPTS = path.join(APP_ROOT, 'scripts');

export const TOKEN = 'fake-supervisor-token';

/**
 * commands — { 'get_config': result | (msg) => result }. A handler may throw to
 *            produce HA's `success:false` error shape.
 * rest      — { 'core/api/config/core/check_config': result | fn }
 * logs      — { 'core/logs': string | (req) => string } (text/plain, ANSI and all)
 * status    — { 'core/logs': 404 } to force an HTTP status
 * authFails — reject the auth handshake
 */
export async function startFakeHa({ commands = {}, rest = {}, logs = {}, status = {}, authFails = false } = {}) {
  const requests = [];

  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const route = url.pathname.replace(/^\/+/, '');
    requests.push({ method: req.method, route, query: Object.fromEntries(url.searchParams) });

    if (status[route]) {
      res.writeHead(status[route], { 'content-type': 'text/plain' });
      return res.end(`${status[route]}: Not Found`);
    }
    if (route in logs) {
      // A function, so a test can make the log grow between two reads — which is
      // exactly what config-check watches for.
      const body = typeof logs[route] === 'function' ? logs[route](req) : logs[route];
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(body);
    }
    if (route in rest) {
      let body = rest[route];
      if (typeof body === 'function') body = body(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404: Not Found');
  });

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = http.address().port;

  const wss = new WebSocketServer({ server: http, path: '/core/api/websocket' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.8.1' }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'auth') {
        if (authFails || msg.access_token !== TOKEN) {
          ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' }));
          return ws.close();
        }
        return ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.8.1' }));
      }

      requests.push({ ws: msg.type, message: msg });
      const handler = commands[msg.type];
      if (handler === undefined) {
        return ws.send(JSON.stringify({
          id: msg.id, type: 'result', success: false,
          error: { code: 'unknown_command', message: `no handler for ${msg.type}` },
        }));
      }
      try {
        const result = typeof handler === 'function' ? handler(msg) : handler;
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result }));
      } catch (e) {
        ws.send(JSON.stringify({
          id: msg.id, type: 'result', success: false,
          error: { code: 'failed', message: e.message },
        }));
      }
    });
  });

  return {
    port,
    requests,
    wsUrl: `ws://127.0.0.1:${port}/core/api/websocket`,
    supervisorUrl: `http://127.0.0.1:${port}`,
    async close() {
      wss.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/**
 * A bin directory containing ha-tools and each of its aliases, symlinked back to
 * the dispatcher exactly as the Dockerfile does — so argv[0] dispatch is under
 * test, not assumed.
 */
let binDir = null;
export function toolsBin() {
  if (binDir) return binDir;
  binDir = mkdtempSync(path.join(tmpdir(), 'ha-tools-bin-'));
  const dispatcher = path.join(SCRIPTS, 'ha-tools.sh');
  for (const name of ['ha-tools', 'ha-history', 'ha-stats', 'ha-timeline', 'ha-lovelace', 'ha-logs']) {
    symlinkSync(dispatcher, path.join(binDir, name));
  }
  return binDir;
}

/** Run a tool as the user would, and hand back everything it produced. */
export function runTool(name, args, { ha, env = {}, cwd, timeout = 20000 } = {}) {
  const bin = path.join(toolsBin(), name);
  return new Promise((resolve) => {
    const proc = spawn('bash', [bin, ...args], {
      cwd: cwd || APP_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        HA_TOKEN: TOKEN,
        SUPERVISOR_TOKEN: TOKEN,
        HA_TOOLS_NODE_PATH: path.join(APP_ROOT, 'node_modules'),
        ...(ha ? { HA_WS_URL: ha.wsUrl, HA_SUPERVISOR_URL: ha.supervisorUrl } : {}),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeout);
    proc.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ code, stdout, stderr, json, lines: stdout.split('\n').filter(Boolean) });
    });
  });
}

/** A scratch /config with an automations.yaml, for the `automation yaml` command. */
export function fakeConfigDir(automationsYaml) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ha-config-'));
  mkdirSync(dir, { recursive: true });
  if (automationsYaml != null) writeFileSync(path.join(dir, 'automations.yaml'), automationsYaml);
  return dir;
}

/** HA's history shape: first point verbose, the rest compact — both spellings. */
export function historyPoints(entityId, points) {
  return points.map((p, i) => (i === 0
    ? { entity_id: entityId, state: p.state, last_updated: new Date(p.ms).toISOString() }
    : { s: p.state, lu: p.ms / 1000 }));   // epoch *seconds*, as a float
}
