/*
 * server-harness — boots the real server/index.js in a child process against a
 * scratch filesystem, with the Agent SDK replaced by the scripted stub, and
 * hands back an HTTP base URL plus WebSocket clients.
 *
 * Nothing here reaches inside the server. Tests drive it exactly as a browser
 * does — which is the point: these assertions have to survive the restructure.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'index.js');
const LOADER = path.join(HERE, 'sdk-loader.mjs');

const DEFAULT_TIMEOUT = 5000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Claude Code encodes the project cwd into the store directory name. */
export function storeDirFor(home, workDir) {
  return path.join(home, '.claude', 'projects', workDir.replaceAll('/', '-'));
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this._waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.messages.push(msg);
      for (const w of [...this._waiters]) {
        if (w.predicate(msg)) {
          this._waiters.splice(this._waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  /** Resolve with the first message matching `predicate`, past or future. */
  waitFor(predicate, { timeout = DEFAULT_TIMEOUT, label = 'message' } = {}) {
    const test = typeof predicate === 'string' ? (m) => m.type === predicate : predicate;
    const existing = this.messages.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { predicate: test, resolve };
      w.timer = setTimeout(() => {
        this._waiters.splice(this._waiters.indexOf(w), 1);
        reject(new Error(
          `timed out after ${timeout}ms waiting for ${typeof predicate === 'string' ? predicate : label}. ` +
          `Saw: ${this.messages.map((m) => m.type).join(', ')}`));
      }, timeout);
      this._waiters.push(w);
    });
  }

  /** Every message of a type received so far. */
  all(type) { return this.messages.filter((m) => m.type === type); }

  /** The most recent message of a type, or undefined. */
  last(type) { return this.all(type).at(-1); }

  close() {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}

export class Harness {
  constructor(opts) { Object.assign(this, opts); }

  get baseUrl() { return `http://127.0.0.1:${this.port}`; }
  get wsUrl() { return `ws://127.0.0.1:${this.port}/ws`; }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    const client = new Client(ws);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket did not open')), DEFAULT_TIMEOUT);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    this.clients.push(client);
    return client;
  }

  async get(pathname) {
    const res = await fetch(this.baseUrl + pathname);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json };
  }

  /** Everything the stub recorded — the options the server built, tool decisions. */
  records(kind) {
    if (!existsSync(this.recordFile)) return [];
    const all = readFileSync(this.recordFile, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return kind ? all.filter((r) => r.kind === kind) : all;
  }

  /** Wait until the stub has recorded something matching, e.g. a query starting. */
  async waitForRecord(predicate, { timeout = DEFAULT_TIMEOUT } = {}) {
    const started = Date.now();
    for (;;) {
      const hit = this.records().find(predicate);
      if (hit) return hit;
      if (Date.now() - started > timeout) {
        throw new Error(`timed out waiting for stub record. Saw: ${this.records().map((r) => r.kind).join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  get stdout() { return this._out.join(''); }

  /** Wait for a line to appear in the app log (the log IS an interface here). */
  async waitForLog(substring, { timeout = DEFAULT_TIMEOUT } = {}) {
    const started = Date.now();
    for (;;) {
      if (this.stdout.includes(substring)) return true;
      if (Date.now() - started > timeout) {
        throw new Error(`timed out waiting for log ${JSON.stringify(substring)}.\n--- log ---\n${this.stdout}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  readData(name) {
    const p = path.join(this.dataDir, name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }

  writeData(name, value) {
    writeFileSync(path.join(this.dataDir, name), JSON.stringify(value));
  }

  /** Stop the server but keep the scratch dirs — for restart-persistence tests. */
  async stopServer() {
    for (const c of this.clients) await c.close();
    this.clients = [];
    if (!this.proc || this.proc.exitCode != null || this.proc.signalCode) return;
    await new Promise((resolve) => {
      // The force-kill timer is unref'd and cleared: left running it holds the
      // event loop open past the end of a test file.
      const force = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {} }, 2000);
      force.unref();
      this.proc.once('exit', () => { clearTimeout(force); resolve(); });
      this.proc.kill('SIGTERM');
    });
  }

  async stop() {
    await this.stopServer();
    try { rmSync(this.root, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Boot a server.
 *
 *   scenario  — stub script (see stub-sdk.mjs)
 *   env       — extra environment (DEBUG_MODE, ALLOW_ADDON_CONFIGS, …)
 *   subscription — seed a .credentials.json so isSubscriptionAuth() is true
 *   sessions  — { id: [jsonl lines…] } written into the session store
 *   data      — { 'auto-continue.json': {...} } written into DATA_DIR
 *   reuse     — a previous harness's scratch root, for restart tests
 */
export async function startServer({
  scenario = { runs: [] }, env = {}, subscription = true, sessions = {}, data = {}, reuse = null,
} = {}) {
  const root = reuse || mkdtempSync(path.join(tmpdir(), 'ccui-test-'));
  const dataDir = path.join(root, 'data');
  const home = path.join(root, 'home');
  const workDir = path.join(root, 'config');
  const frontendDir = path.join(APP_ROOT, 'frontend');
  const claudeConfigDir = path.join(dataDir, '.config', 'claude');
  const store = storeDirFor(home, workDir);

  for (const d of [dataDir, home, workDir, claudeConfigDir, store]) mkdirSync(d, { recursive: true });

  if (subscription) {
    writeFileSync(path.join(claudeConfigDir, '.credentials.json'), JSON.stringify({ stub: true }));
  }
  for (const [id, lines] of Object.entries(sessions)) {
    writeFileSync(path.join(store, `${id}.jsonl`),
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  for (const [name, value] of Object.entries(data)) {
    writeFileSync(path.join(dataDir, name), JSON.stringify(value));
  }

  const scenarioFile = path.join(root, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const recordFile = path.join(root, 'stub-record.jsonl');
  writeFileSync(recordFile, '');

  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', LOADER, SERVER_ENTRY], {
    cwd: APP_ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      SERVER_PORT: String(port),
      WORK_DIR: workDir,
      DATA_DIR: dataDir,
      FRONTEND_DIR: frontendDir,
      HOME: home,
      ANTHROPIC_CONFIG_DIR: claudeConfigDir,
      PLUGIN_DIR: path.join(APP_ROOT, 'plugins', 'homeassistant-config'),
      STUB_SDK_SCENARIO: scenarioFile,
      STUB_SDK_RECORD: recordFile,
      // No SUPERVISOR_TOKEN by default: refreshHaLinks() returns immediately
      // rather than trying to reach a Supervisor that isn't there.
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = [];
  proc.stdout.on('data', (c) => out.push(c.toString()));
  proc.stderr.on('data', (c) => out.push(c.toString()));

  const harness = new Harness({
    proc, port, root, dataDir, home, workDir, store, claudeConfigDir,
    scenarioFile, recordFile, clients: [], _out: out,
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start.\n${out.join('')}`)), 15000);
    const check = () => {
      if (out.join('').includes('listening on port')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', check);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}\n${out.join('')}`));
    });
    check();
  });

  return harness;
}

/** A minimal well-formed transcript line, for seeding the session store. */
export function userLine(text, extra = {}) {
  return { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text }, ...extra };
}
export function assistantLine(blocks, extra = {}) {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: blocks }, ...extra };
}
