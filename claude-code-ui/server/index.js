import { createServer } from 'http';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';

const PORT = parseInt(process.env.SERVER_PORT || '7681', 10);
const WORK_DIR = process.env.WORK_DIR || '/config';
const PLUGIN_DIR = process.env.PLUGIN_DIR || '/opt/plugins/homeassistant-config';
const CLAUDE_CONFIG_DIR = process.env.ANTHROPIC_CONFIG_DIR || '/data/.config/claude';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const DEFAULT_PERMISSION_MODE = process.env.DEFAULT_PERMISSION_MODE || 'ask';

// Tools auto-approved in 'acceptEdits' mode (file edits only).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

// The permission mode for the in-flight run. Updated live by `set_perm_mode`
// messages so the user can change how tools are approved mid-prompt.
let activePermMode = DEFAULT_PERMISSION_MODE;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static('/opt/frontend'));

// ── Diagnostics ───────────────────────────────────────────────────────────
// Read-only auth/connectivity probe, only registered when the `debug` add-on
// option is enabled (DEBUG_MODE). Runnable from the supervisor network:
//   curl http://<addon-ip>:7681/diag | jq .
// Tests ha-ws-client (WebSocket) and the REST supervisor proxy with the exact
// environment the add-on runs under, so we can see what actually authenticates.
const execAsync = promisify(exec);

async function runCmd(cmd, timeoutMs = 15000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024, shell: '/bin/bash',
    });
    return { ok: true, stdout: stdout.toString().trim().slice(0, 1500), stderr: stderr.toString().trim().slice(0, 400) };
  } catch (e) {
    return {
      ok: false,
      error: String(e.message || e).slice(0, 400),
      stdout: String(e.stdout || '').trim().slice(0, 1500),
      stderr: String(e.stderr || '').trim().slice(0, 400),
    };
  }
}

if (DEBUG_MODE) app.get('/diag', async (_req, res) => {
  const tok = process.env.SUPERVISOR_TOKEN || '';
  const out = {
    env: {
      has_SUPERVISOR_TOKEN: !!tok,
      supervisor_token_len: tok.length,
      WORK_DIR: process.env.WORK_DIR,
    },
    tests: {},
  };
  out.tests.ws_ping        = await runCmd('ha-ws-client ping 2>&1 | head -c 400');
  out.tests.ws_config      = await runCmd('ha-ws-client config 2>&1 | head -c 400');
  out.tests.ws_template    = await runCmd(`ha-ws-client template '{{ now() }}' 2>&1 | head -c 400`);
  out.tests.rest_api_root  = await runCmd(`curl -s -m 10 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/`);
  out.tests.rest_states    = await runCmd(`curl -s -m 10 -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/states | head -c 60`);
  out.tests.rest_lovelace  = await runCmd(`curl -s -m 10 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/lovelace/config`);
  out.tests.rest_dashboards = await runCmd(`curl -s -m 10 -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/lovelace/dashboards | head -c 200`);
  out.tests.lovelace_list  = await runCmd('ha-lovelace list 2>&1 | head -c 500');
  out.tests.lovelace_get   = await runCmd('ha-lovelace get 2>&1 | head -c 300');
  // Extract any mcpServers definitions persisted in ~/.claude.json (global + per-project)
  out.tests.claude_json_mcp = await runCmd(
    `python3 -c "import json; d=json.load(open('${process.env.HOME || '/data/home'}/.claude.json')); ` +
    `print(json.dumps({'global_mcpServers': list((d.get('mcpServers') or {}).keys()), ` +
    `'project_mcpServers': {k: list((v.get('mcpServers') or {}).keys()) for k,v in (d.get('projects') or {}).items()}}, indent=2))" 2>&1`
  );
  res.json(out);
});

// Dump the Claude config files the SDK may load MCP servers / settings from.
if (DEBUG_MODE) app.get('/diag/config', (_req, res) => {
  const home = process.env.HOME || '/data/home';
  const candidates = [
    `${home}/.claude.json`,
    `${home}/.claude/settings.json`,
    `${home}/.claude/settings.local.json`,
    `${home}/.claude/.mcp.json`,
    `${CLAUDE_CONFIG_DIR}/.claude.json`,
    `${CLAUDE_CONFIG_DIR}/settings.json`,
    `${CLAUDE_CONFIG_DIR}/settings.local.json`,
    `${CLAUDE_CONFIG_DIR}/.mcp.json`,
    `${WORK_DIR}/.mcp.json`,
    `${WORK_DIR}/.claude.json`,
    `${WORK_DIR}/.claude/settings.json`,
    `${WORK_DIR}/.claude/settings.local.json`,
  ];
  const files = {};
  for (const p of candidates) {
    if (!existsSync(p)) { files[p] = null; continue; }
    try { files[p] = readFileSync(p, 'utf8').slice(0, 4000); }
    catch (e) { files[p] = `<read error: ${e.message}>`; }
  }
  res.json({ HOME: home, CLAUDE_CONFIG_DIR, WORK_DIR, files });
});

// Run a real headless agent query and stream back what happens — emulates a
// user prompt so we can see which MCP servers load and what tools error.
//   curl 'http://<addon-ip>:7681/diag/query?q=...'
if (DEBUG_MODE) app.get('/diag/query', async (req, res) => {
  const prompt = (req.query.q || 'Reply with the single word: ok').toString();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 120000);
  const events = [];

  const opts = {
    cwd: WORK_DIR,
    abortController,
    plugins: [{ type: 'local', path: PLUGIN_DIR }],
    // Auto-approve every tool (bypassPermissions is refused when running as root).
    canUseTool: (_t, input) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  };

  try {
    for await (const event of query({ prompt, options: opts })) {
      if (event.type === 'system' && event.subtype === 'init') {
        events.push({ init: { model: event.model, mcp_servers: event.mcp_servers, slash_commands: event.slash_commands } });
      } else if (event.type === 'assistant') {
        for (const block of (event.message?.content || [])) {
          if (block.type === 'text' && block.text) events.push({ text: block.text });
          else if (block.type === 'tool_use') events.push({ tool_use: { name: block.name, input: block.input } });
        }
      } else if (event.type === 'user') {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const o = typeof block.content === 'string' ? block.content
                : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('')
                : JSON.stringify(block.content);
              events.push({ tool_result: { isError: !!block.is_error, output: String(o).slice(0, 800) } });
            }
          }
        }
      } else if (event.type === 'result') {
        events.push({ result: { subtype: event.subtype, cost: event.total_cost_usd, turns: event.num_turns } });
        break;
      }
    }
  } catch (e) {
    events.push({ error: String(e?.message || e) });
  } finally {
    clearTimeout(timer);
  }
  res.json({ prompt, events });
});

// Inspect the active session (resume id + parsed transcript length).
if (DEBUG_MODE) app.get('/diag/conv', (req, res) => {
  if (req.query.clear) { abortActive(); activeSessionId = null; saveActive(); broadcast({ type: 'cleared' }); }
  const items = parseSession(activeSessionId);
  res.json({ activeSessionId, count: items.length, last: items.slice(-8), sessionCount: listSessions().length });
});

// Drive one real turn through the session/resume path (no browser needed).
if (DEBUG_MODE) app.get('/diag/feed', async (req, res) => {
  const q = (req.query.q || 'Say hello in three words.').toString();
  const dummyWs = { readyState: 3 };  // never open / never in `connections`
  await runQuery(dummyWs, { pendingPermissions: new Map() }, { text: q, permissionMode: 'auto' });
  const items = parseSession(activeSessionId);
  res.json({ activeSessionId, count: items.length, last: items.slice(-6) });
});

// Grep across all stored sessions for a term, returning readable snippets.
if (DEBUG_MODE) app.get('/diag/grep', (req, res) => {
  const term = (req.query.q || '').toString().toLowerCase();
  if (!term) return res.json({ error: 'provide ?q=' });
  if (!existsSync(STORE_DIR)) return res.json({ term, results: [] });
  const results = [];
  for (const f of readdirSync(STORE_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    let content; try { content = readFileSync(path.join(STORE_DIR, f), 'utf8'); } catch { continue; }
    if (!content.toLowerCase().includes(term)) continue;
    const snippets = [];
    for (const ln of content.split('\n')) {
      if (!ln.toLowerCase().includes(term)) continue;
      let obj; try { obj = JSON.parse(ln); } catch { continue; }
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      const c = obj.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c)
        ? c.map((b) => b.text || (b.type === 'tool_use' ? JSON.stringify(b.input) : '') ||
            (b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : '')).join(' ')
        : '';
      const lower = text.toLowerCase();
      let idx = lower.indexOf(term);
      while (idx !== -1 && snippets.length < 10) {
        snippets.push({ role: obj.message.role, text: text.slice(Math.max(0, idx - 160), idx + 220).replace(/\s+/g, ' ').trim() });
        idx = lower.indexOf(term, idx + term.length);
      }
    }
    if (snippets.length) results.push({ id, title: sessionTitle(id), hits: snippets.length, snippets });
  }
  results.sort((a, b) => b.hits - a.hits);
  res.json({ term, sessionsWithHits: results.length, results });
});

// Test whether a uvx package (e.g. ha-mcp) installs/runs on this image.
if (DEBUG_MODE) app.get('/diag/uvx', async (req, res) => {
  const pkg = (req.query.pkg || 'ha-mcp@7.8.1').toString().replace(/[^a-zA-Z0-9.@_-]/g, '');
  const py = (req.query.py || '').toString().replace(/[^0-9.]/g, '');
  const pyFlag = py ? `--python ${py} ` : '';
  const r = await runCmd(`timeout 230 uvx ${pyFlag}${pkg} --help 2>&1 | head -c 2500`, 240000);
  res.json({ pkg, py, result: r });
});

// List sessions parsed from the store (for building/verifying multi-session).
// ?id=<sessionId> dumps that session's parsed transcript; ?find=<substr> filters list.
if (DEBUG_MODE) app.get('/diag/sesslist', (req, res) => {
  if (req.query.id) return res.json({ id: req.query.id, items: parseSession(req.query.id.toString()) });
  let sessions = listSessions();
  if (req.query.find) sessions = sessions.filter((s) => s.title.toLowerCase().includes(req.query.find.toString().toLowerCase()));
  res.json({ store: STORE_DIR, active: activeSessionId, sessions });
});

// Probe Claude Code's on-disk session store (JSONL transcripts) so we can build
// multi-session browsing on top of the canonical store.
if (DEBUG_MODE) app.get('/diag/sessions', async (_req, res) => {
  const home = process.env.HOME || '/data/home';
  const candidates = [
    path.join(home, '.claude', 'projects'),
    path.join(CLAUDE_CONFIG_DIR, 'projects'),
  ];
  const out = { candidates: {}, sample: null };
  const { readdirSync, statSync } = await import('fs');
  for (const dir of candidates) {
    if (!existsSync(dir)) { out.candidates[dir] = null; continue; }
    const projects = {};
    for (const proj of readdirSync(dir)) {
      const pdir = path.join(dir, proj);
      try {
        const files = readdirSync(pdir).filter((f) => f.endsWith('.jsonl'));
        projects[proj] = files.map((f) => {
          const st = statSync(path.join(pdir, f));
          return { file: f, size: st.size, mtime: st.mtimeMs };
        });
      } catch { projects[proj] = '<unreadable>'; }
    }
    out.candidates[dir] = projects;
    // grab a sample: first 3 lines of the newest jsonl in this dir
    if (!out.sample) {
      let newest = null;
      for (const [proj, files] of Object.entries(projects)) {
        if (!Array.isArray(files)) continue;
        for (const f of files) {
          if (!newest || f.mtime > newest.mtime) newest = { ...f, proj };
        }
      }
      if (newest) {
        const lines = readFileSync(path.join(dir, newest.proj, newest.file), 'utf8').split('\n').slice(0, 4);
        out.sample = { path: path.join(dir, newest.proj, newest.file), firstLines: lines };
      }
    }
  }
  res.json(out);
});

app.get('*', (_req, res) => res.sendFile('/opt/frontend/index.html'));

// ── MCP state hygiene ─────────────────────────────────────────────────────────
// The Claude Code CLI persists MCP servers into ~/.claude.json (globally and
// per-project). An earlier build that ran with ha-mcp enabled wrote a
// `home-assistant` server under projects["/config"], and the SDK auto-loads it
// on every run. ha-mcp has since been removed entirely (we use ha-ws-client /
// ha-lovelace instead), so strip any persisted MCP definitions at start.
function sanitizeMcpState() {
  const file = path.join(process.env.HOME || '/data/home', '.claude.json');
  if (!existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    let changed = false;
    if (data.mcpServers && Object.keys(data.mcpServers).length) { data.mcpServers = {}; changed = true; }
    if (data.projects && typeof data.projects === 'object') {
      for (const proj of Object.values(data.projects)) {
        if (proj && proj.mcpServers && Object.keys(proj.mcpServers).length) { proj.mcpServers = {}; changed = true; }
      }
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(data, null, 2));
      console.log('Sanitized persisted mcpServers from .claude.json (MCP is managed via opts only)');
    }
  } catch (e) {
    console.warn('Could not sanitize .claude.json:', e.message);
  }
}

// ── Auth helpers ────────────────────────────────────────────────────────────

function isAuthenticated() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  return existsSync(path.join(CLAUDE_CONFIG_DIR, '.credentials.json'));
}

// One active login process shared across all connections
let loginProc = null;
let loginPollInterval = null;

function stopLoginProc() {
  if (loginPollInterval) { clearInterval(loginPollInterval); loginPollInterval = null; }
  if (loginProc) { try { loginProc.kill(); } catch {} loginProc = null; }
}

function startLoginFlow(notifyAll) {
  stopLoginProc();

  loginProc = spawn('claude', ['auth', 'login'], {
    env: {
      ...process.env,
      BROWSER: '/opt/scripts/browser-capture.sh',
      DISPLAY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const URL_RE = /https?:\/\/[^\s\n"'<>]+/;
  let sentUrl = false;

  function tryCapture(chunk) {
    if (sentUrl) return;
    const text = chunk.toString();
    // BROWSER_URL: prefix from our capture script, or raw URL in output
    const tagged = text.match(/BROWSER_URL:(https?:\/\/[^\s\n]+)/);
    const raw    = text.match(URL_RE);
    const url    = (tagged && tagged[1]) || (raw && raw[0]);
    if (url) {
      sentUrl = true;
      notifyAll({ type: 'auth_url', url });
      startPolling(notifyAll);
    }
  }

  loginProc.stdout.on('data', tryCapture);
  loginProc.stderr.on('data', tryCapture);

  loginProc.on('exit', () => {
    loginProc = null;
    if (isAuthenticated()) {
      stopLoginProc();
      notifyAll({ type: 'auth_status', authenticated: true });
    }
  });
}

function startPolling(notifyAll) {
  if (loginPollInterval) return;
  loginPollInterval = setInterval(() => {
    if (isAuthenticated()) {
      stopLoginProc();
      notifyAll({ type: 'auth_status', authenticated: true });
    }
  }, 2000);
}

// ── WebSocket ───────────────────────────────────────────────────────────────

const connections = new Set();

// Plugin/agent slash commands, discovered from the SDK init event and cached
// so newly-connected clients can populate their autocomplete immediately.
let cachedSlashCommands = [];

function broadcast(msg) {
  for (const ws of connections) send(ws, msg);
}

// ── Sessions (Claude Code's on-disk store) ───────────────────────────────────
// Multi-session is built on Claude Code's canonical JSONL transcript store at
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — the same store the CLI
// uses, so sessions are interchangeable. We keep only a tiny pointer to the
// "active" session on /data; transcripts are always read from the store.
const STORE_DIR = path.join(process.env.HOME || '/data/home', '.claude', 'projects', WORK_DIR.replace(/\//g, '-'));
const ACTIVE_FILE = path.join('/data', 'active-session.json');
let activeSessionId = null;
let activeQuery = null;        // AbortController for the in-flight query (global)

function loadActive() {
  try {
    if (existsSync(ACTIVE_FILE)) activeSessionId = JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')).sessionId || null;
  } catch (e) { console.warn('Could not load active session:', e.message); }
  // If the pointer references a session that no longer exists, drop it.
  if (activeSessionId && !existsSync(path.join(STORE_DIR, `${activeSessionId}.jsonl`))) activeSessionId = null;
}

function saveActive() {
  try { writeFileSync(ACTIVE_FILE, JSON.stringify({ sessionId: activeSessionId })); }
  catch (e) { console.warn('Could not save active session:', e.message); }
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b.text || '')).join('');
  return JSON.stringify(content);
}

// Turn one stored JSONL line into render item(s), matching the live event shapes.
function lineToItems(line) {
  const items = [];
  const msg = line.message;
  if (line.isMeta || line.isSidechain || line.isCompactSummary || !msg) return items;
  if (line.type === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim()) items.push({ kind: 'user', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text) items.push({ kind: 'user', text: b.text });
        else if (b.type === 'tool_result') {
          const raw = blockText(b.content);
          items.push({ kind: 'tool_result', id: b.tool_use_id, output: raw.length > 4000 ? raw.slice(0, 4000) + '\n…[truncated]' : raw, isError: !!b.is_error });
        }
      }
    }
  } else if (line.type === 'assistant') {
    for (const b of (msg.content || [])) {
      if (b.type === 'text' && b.text) items.push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') items.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
  }
  return items;
}

function parseSession(id) {
  const file = path.join(STORE_DIR, `${id}.jsonl`);
  if (!id || !existsSync(file)) return [];
  const items = [];
  for (const ln of readFileSync(file, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let obj; try { obj = JSON.parse(ln); } catch { continue; }
    items.push(...lineToItems(obj));
  }
  return items;
}

function sessionTitle(id) {
  const file = path.join(STORE_DIR, `${id}.jsonl`);
  try {
    for (const ln of readFileSync(file, 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      let obj; try { obj = JSON.parse(ln); } catch { continue; }
      if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) continue;
      const c = obj.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text || '') : '';
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 80 ? t.slice(0, 80) + '…' : t;
    }
  } catch {}
  return null;
}

function listSessions() {
  if (!existsSync(STORE_DIR)) return [];
  const out = [];
  for (const f of readdirSync(STORE_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    let mtime = 0; try { mtime = statSync(path.join(STORE_DIR, f)).mtimeMs; } catch {}
    const title = sessionTitle(id);
    if (!title) continue;   // skip empty/junk sessions with no user prompt
    out.push({ id, title, updatedAt: mtime });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function deleteSession(id) {
  try { unlinkSync(path.join(STORE_DIR, `${id}.jsonl`)); return true; }
  catch (e) { console.warn('Could not delete session:', e.message); return false; }
}

function abortActive() {
  if (activeQuery) { activeQuery.abort(); activeQuery = null; }
}

wss.on('connection', (ws) => {
  connections.add(ws);

  const state = {
    pendingPermissions: new Map(),
    pendingDialogs: new Map(),
  };
  ws._state = state;   // exposed so set_perm_mode can resolve prompts across tabs

  // Greet and immediately report auth status + any known slash commands
  send(ws, { type: 'connected' });
  send(ws, { type: 'config', defaultPermMode: DEFAULT_PERMISSION_MODE });
  send(ws, { type: 'auth_status', authenticated: isAuthenticated() });
  send(ws, { type: 'slash_commands', commands: cachedSlashCommands });
  // Restore the active session's transcript + the session list on (re)connect
  send(ws, { type: 'sessions', sessions: listSessions(), activeId: activeSessionId });
  send(ws, { type: 'history', items: parseSession(activeSessionId), running: !!activeQuery });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth_check') {
      send(ws, { type: 'auth_status', authenticated: isAuthenticated() });

    } else if (msg.type === 'auth_login') {
      startLoginFlow(broadcast);
    } else if (msg.type === 'auth_code') {
      if (loginProc && loginProc.stdin) {
        loginProc.stdin.write(msg.code + '\n');
      }

    } else if (msg.type === 'prompt') {
      runQuery(ws, state, msg);
    } else if (msg.type === 'abort') {
      abortActive();
    } else if (msg.type === 'new_session') {
      abortActive();
      activeSessionId = null;
      saveActive();
      broadcast({ type: 'cleared' });
      broadcast({ type: 'sessions', sessions: listSessions(), activeId: activeSessionId });
    } else if (msg.type === 'sessions_list') {
      send(ws, { type: 'sessions', sessions: listSessions(), activeId: activeSessionId });
    } else if (msg.type === 'session_switch') {
      abortActive();
      activeSessionId = msg.id || null;
      saveActive();
      broadcast({ type: 'history', items: parseSession(activeSessionId), running: false });
      broadcast({ type: 'sessions', sessions: listSessions(), activeId: activeSessionId });
    } else if (msg.type === 'session_delete') {
      deleteSession(msg.id);
      if (msg.id === activeSessionId) { activeSessionId = null; saveActive(); broadcast({ type: 'cleared' }); }
      broadcast({ type: 'sessions', sessions: listSessions(), activeId: activeSessionId });
    } else if (msg.type === 'permission_response') {
      const entry = state.pendingPermissions.get(msg.id);
      if (entry) {
        state.pendingPermissions.delete(msg.id);
        entry.resolve(msg.decision === 'allow');
      }
    } else if (msg.type === 'user_dialog_response') {
      // Reply to an onUserDialog request (e.g. AskUserQuestion). `result` is the
      // SDK-defined answer shape; its absence means the user dismissed the dialog.
      const resolve = state.pendingDialogs.get(msg.id);
      if (resolve) {
        state.pendingDialogs.delete(msg.id);
        resolve(msg.result === undefined
          ? { behavior: 'cancelled' }
          : { behavior: 'completed', result: msg.result });
      }
    } else if (msg.type === 'set_perm_mode') {
      // Change how tools are approved mid-prompt. Takes effect immediately for
      // ask/acceptEdits/bypass runs (which route through canUseTool). A run
      // started in 'auto' keeps the SDK classifier for its duration.
      activePermMode = msg.mode;
      if (msg.mode === 'bypass' || msg.mode === 'acceptEdits') {
        // Auto-resolve any outstanding prompts the new mode would now allow,
        // across every connected tab, so the user isn't left waiting.
        for (const conn of connections) {
          const pending = conn._state?.pendingPermissions;
          if (!pending) continue;
          for (const [id, entry] of pending) {
            if (msg.mode === 'bypass' || EDIT_TOOLS.has(entry.toolName)) {
              pending.delete(id);
              entry.resolve(true);
              send(conn, { type: 'permission_resolved', id });
            }
          }
        }
      }
    }
  });

  ws.on('close', () => {
    connections.delete(ws);
    // Do NOT abort the active query — it keeps running and persisting so the
    // chat is complete when the user navigates back. Just clear any pending
    // permission prompts tied to this (now gone) client so the run doesn't hang.
    for (const entry of state.pendingPermissions.values()) entry.resolve(false);
    state.pendingPermissions.clear();
    for (const resolve of state.pendingDialogs.values()) resolve({ behavior: 'cancelled' });
    state.pendingDialogs.clear();
  });
});

async function runQuery(ws, state, { text, permissionMode, model }) {
  abortActive();

  const abortController = new AbortController();
  activeQuery = abortController;

  // Show the user's message on other clients (sender rendered it locally; the
  // SDK persists it to the session store, so nothing to record ourselves).
  for (const c of connections) if (c !== ws) send(c, { type: 'user', text });

  const opts = {
    cwd: WORK_DIR,
    abortController,
    plugins: [{ type: 'local', path: PLUGIN_DIR }],
  };

  if (model) opts.model = model;

  // Set the live mode for this run. 'auto' uses the SDK's native classifier and
  // is fixed for the run; ask/acceptEdits/bypass route through canUseTool, which
  // reads `activePermMode` at call time so the user can switch modes mid-prompt.
  activePermMode = permissionMode || DEFAULT_PERMISSION_MODE;

  if (activePermMode === 'auto') {
    // A model classifier approves/denies each tool — no prompts, no canUseTool.
    opts.permissionMode = 'auto';
  } else {
    opts.canUseTool = (toolName, input, options) => {
      const mode = activePermMode;
      // Auto-allow without prompting when the current mode permits it.
      if (mode === 'bypass' || (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName))) {
        return Promise.resolve({ behavior: 'allow', updatedInput: input });
      }
      // Otherwise ('ask', or a non-edit tool under acceptEdits): prompt the user.
      return new Promise((resolve) => {
        const id = randomUUID();
        send(ws, {
          type: 'permission_request',
          id,
          toolName,
          input,
          title: options.title,
          description: options.description,
        });
        const finish = (allowed) => resolve(allowed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Denied by user' });
        state.pendingPermissions.set(id, { toolName, resolve: finish });
        options.signal.addEventListener('abort', () => {
          state.pendingPermissions.delete(id);
          resolve({ behavior: 'deny', message: 'Aborted' });
        }, { once: true });
      });
    };
  }

  // Interactive tools (AskUserQuestion) reach the host via onUserDialog rather
  // than canUseTool. Render them in the browser and feed the answer back. Web
  // hosts want HTML option previews instead of the CLI's monospace markdown.
  opts.toolConfig = { askUserQuestion: { previewFormat: 'html' } };
  opts.onUserDialog = (request, { signal }) => new Promise((resolve) => {
    // The payload/result shapes are SDK-defined and transported opaquely; log
    // them so the exact AskUserQuestion contract can be confirmed in the field.
    console.log('[onUserDialog]', request.dialogKind, JSON.stringify(request.payload));
    const id = randomUUID();
    send(ws, {
      type: 'user_dialog',
      id,
      dialogKind: request.dialogKind,
      payload: request.payload,
      toolUseID: request.toolUseID,
    });
    state.pendingDialogs.set(id, resolve);
    signal.addEventListener('abort', () => {
      if (state.pendingDialogs.delete(id)) resolve({ behavior: 'cancelled' });
    }, { once: true });
  });

  const resuming = !!activeSessionId;
  if (resuming) {
    opts.resume = activeSessionId;
  }

  // Ask the SDK for the real, cache-inclusive context-window usage and push it
  // to every client so the indicator reflects progress toward auto-compaction.
  const reportContextUsage = async (q) => {
    try {
      const u = await q.getContextUsage();
      broadcast({
        type: 'context_usage',
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        autoCompactThreshold: u.autoCompactThreshold,
        autoCompactEnabled: u.isAutoCompactEnabled,
      });
    } catch { /* control request can fail if the session just ended — ignore */ }
  };

  try {
    // Events are broadcast to every connected client. Persistence is handled by
    // the SDK writing to the session store — independent of the requester.
    const q = query({ prompt: text, options: opts });
    for await (const event of q) {
      if (event.type === 'system' && event.subtype === 'init') {
        activeSessionId = event.session_id;
        saveActive();
        broadcast({ type: 'session', id: event.session_id });
        if (event.model) broadcast({ type: 'model', model: event.model });
        if (Array.isArray(event.slash_commands)) {
          cachedSlashCommands = event.slash_commands;
          broadcast({ type: 'slash_commands', commands: cachedSlashCommands });
        }

      } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
        const m = event.compact_metadata || {};
        broadcast({ type: 'compacted', trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens });
        await reportContextUsage(q);

      } else if (event.type === 'assistant') {
        for (const block of (event.message?.content || [])) {
          if (block.type === 'text' && block.text) {
            broadcast({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            broadcast({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          }
        }

      } else if (event.type === 'user') {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const raw = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map(b => b.text || '').join('')
                  : JSON.stringify(block.content);
              const output = raw.length > 4000 ? raw.slice(0, 4000) + '\n…[truncated]' : raw;
              broadcast({ type: 'tool_result', id: block.tool_use_id, output, isError: block.is_error });
            }
          }
        }

      } else if (event.type === 'result') {
        broadcast({
          type: 'result',
          success: event.subtype === 'success',
          cost: event.total_cost_usd,
          turns: event.num_turns,
          inputTokens: event.usage?.input_tokens ?? 0,
          outputTokens: event.usage?.output_tokens ?? 0,
          cacheReadTokens: event.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: event.usage?.cache_creation_input_tokens ?? 0,
        });
        await reportContextUsage(q);
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const message = String(err?.message || err);
      // A stale resume id (e.g. after the SDK session expired) — drop it so the
      // next prompt starts a fresh session.
      if (resuming) { activeSessionId = null; saveActive(); }
      broadcast({ type: 'error', message });
    }
  } finally {
    if (activeQuery === abortController) activeQuery = null;
    if (abortController.signal.aborted) {
      broadcast({ type: 'aborted' });
    }
    // Refresh the session list so the new/updated session (and its title) appears
    broadcast({ type: 'sessions', sessions: listSessions(), activeId: activeSessionId });
  }
}

function send(ws, data) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

sanitizeMcpState();
loadActive();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code UI listening on port ${PORT}`);
  console.log(`  Working dir: ${WORK_DIR}`);
  console.log(`  Plugin dir:  ${PLUGIN_DIR}`);
});
