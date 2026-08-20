/*
 * Diagnostics — read-only probes of what actually authenticates and what the SDK
 * actually loads, runnable from the Supervisor network:
 *
 *   IP=$(ha apps info local_claude-code-ui --raw-json | jq -r .data.ip_address)
 *   curl http://$IP:7681/diag | jq .
 *
 * Registered ONLY when the `debug` app option is on. When it is off these routes
 * do not exist at all and requests fall through to the SPA, which is why the
 * live smoke test checks for JSON rather than a status code.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  WORK_DIR, CLAUDE_CONFIG_DIR, STORE_DIR, HOME_DIR, PLUGINS, SUPERVISOR_URL,
} from './config.js';
import { runtime } from './state.js';
import { broadcast } from './broadcast.js';
import { runCmd } from './exec.js';
import { isSubscriptionAuth } from './auth.js';
import { parseSession, listSessions, sessionTitle, saveActive } from './sessions.js';
import { ADDON_CONFIGS_HOOKS } from './permissions.js';
import { runQuery, abortActive } from './run-query.js';
import * as autoContinue from './auto-continue.js';

export function registerDiagRoutes(app) {
  // Env + auth/connectivity probes, run with the exact environment the app uses.
  app.get('/diag', async (_req, res) => {
    const tok = process.env.SUPERVISOR_TOKEN || '';
    const out = {
      env: { has_SUPERVISOR_TOKEN: !!tok, supervisor_token_len: tok.length, WORK_DIR: process.env.WORK_DIR },
      tests: {},
    };
    const auth = `-H "Authorization: Bearer $SUPERVISOR_TOKEN"`;
    out.tests.ws_ping = await runCmd('ha-ws-client ping 2>&1 | head -c 400');
    out.tests.ws_config = await runCmd('ha-ws-client config 2>&1 | head -c 400');
    out.tests.ws_template = await runCmd(`ha-ws-client template '{{ now() }}' 2>&1 | head -c 400`);
    out.tests.rest_api_root = await runCmd(`curl -s -m 10 -o /dev/null -w "%{http_code}" ${auth} ${SUPERVISOR_URL}/core/api/`);
    out.tests.rest_states = await runCmd(`curl -s -m 10 ${auth} ${SUPERVISOR_URL}/core/api/states | head -c 60`);
    out.tests.rest_lovelace = await runCmd(`curl -s -m 10 -o /dev/null -w "%{http_code}" ${auth} ${SUPERVISOR_URL}/core/api/lovelace/config`);
    out.tests.rest_dashboards = await runCmd(`curl -s -m 10 ${auth} ${SUPERVISOR_URL}/core/api/lovelace/dashboards | head -c 200`);
    out.tests.lovelace_list = await runCmd('ha-lovelace list 2>&1 | head -c 500');
    out.tests.lovelace_get = await runCmd('ha-lovelace get 2>&1 | head -c 300');
    // Any mcpServers still persisted in ~/.claude.json (global + per-project).
    out.tests.claude_json_mcp = await runCmd(
      `python3 -c "import json; d=json.load(open('${HOME_DIR}/.claude.json')); ` +
      `print(json.dumps({'global_mcpServers': list((d.get('mcpServers') or {}).keys()), ` +
      `'project_mcpServers': {k: list((v.get('mcpServers') or {}).keys()) for k,v in (d.get('projects') or {}).items()}}, indent=2))" 2>&1`
    );
    res.json(out);
  });

  // Which Claude config files exist, and what the SDK might load from them.
  app.get('/diag/config', (_req, res) => {
    const candidates = [
      `${HOME_DIR}/.claude.json`,
      `${HOME_DIR}/.claude/settings.json`,
      `${HOME_DIR}/.claude/settings.local.json`,
      `${HOME_DIR}/.claude/.mcp.json`,
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
    res.json({ HOME: HOME_DIR, CLAUDE_CONFIG_DIR, WORK_DIR, files });
  });

  // A real headless agent query, streamed back — the fastest way to emulate a
  // user prompt and see which tools load and what errors come back.
  app.get('/diag/query', async (req, res) => {
    const prompt = (req.query.q || 'Reply with the single word: ok').toString();
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 120000);
    const events = [];

    const opts = {
      cwd: WORK_DIR,
      abortController,
      plugins: PLUGINS,
      // Auto-approve every tool (bypassPermissions is refused when running as root).
      canUseTool: (_t, input) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
      toolConfig: { askUserQuestion: { previewFormat: 'html' } },
      onUserDialog: (request) => {
        events.push({ user_dialog: { dialogKind: request.dialogKind, payload: request.payload, toolUseID: request.toolUseID } });
        return Promise.resolve({ behavior: 'cancelled' });
      },
    };
    // Mirror the live guard: block /addon_configs unless the option enables it.
    if (ADDON_CONFIGS_HOOKS) opts.hooks = ADDON_CONFIGS_HOOKS;

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
              if (block.type !== 'tool_result') continue;
              const o = typeof block.content === 'string' ? block.content
                : Array.isArray(block.content) ? block.content.map((b) => b.text || '').join('')
                  : JSON.stringify(block.content);
              events.push({ tool_result: { isError: !!block.is_error, output: String(o).slice(0, 800) } });
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

  // Auto-continue state, and a way to exercise the schedule→resume path without
  // waiting for a real usage limit: ?simulate=<seconds>.
  app.get('/diag/autocontinue', (req, res) => {
    const sim = req.query.simulate;
    if (sim != null) {
      if (!isSubscriptionAuth()) return res.json({ error: 'not subscription auth' });
      if (!runtime.activeSessionId) return res.json({ error: 'no active session to resume' });
      const secs = Math.max(1, parseInt(sim, 10) || 5);
      autoContinue.autoContinue.enabled = true;
      autoContinue.save();
      autoContinue.schedule({
        resetsAt: Math.floor(Date.now() / 1000) + secs,
        rateLimitType: 'five_hour',
        model: null, effort: null, permissionMode: 'bypass', attempts: 1,
      });
    }
    res.json({
      enabled: autoContinue.autoContinue.enabled,
      pending: autoContinue.autoContinue.pending,
      timerArmed: autoContinue.isTimerArmed(),
      subscription: isSubscriptionAuth(),
      activeSessionId: runtime.activeSessionId,
    });
  });

  // The active session: resume id and parsed transcript length. ?clear=1 clears it.
  app.get('/diag/conv', (req, res) => {
    if (req.query.clear) {
      abortActive();
      runtime.activeSessionId = null;
      saveActive();
      broadcast({ type: 'cleared' });
    }
    const items = parseSession(runtime.activeSessionId);
    res.json({
      activeSessionId: runtime.activeSessionId,
      count: items.length,
      last: items.slice(-8),
      sessionCount: listSessions().length,
    });
  });

  // Drive one real turn through the session/resume path, with no browser.
  app.get('/diag/feed', async (req, res) => {
    const q = (req.query.q || 'Say hello in three words.').toString();
    const headlessWs = { readyState: 3 };   // never open, never in `connections`
    await runQuery(headlessWs, { pendingPermissions: new Map() }, { text: q, permissionMode: 'auto' });
    const items = parseSession(runtime.activeSessionId);
    res.json({ activeSessionId: runtime.activeSessionId, count: items.length, last: items.slice(-6) });
  });

  // Search every stored session for a term, returning readable snippets.
  app.get('/diag/grep', (req, res) => {
    const term = (req.query.q || '').toString().toLowerCase();
    if (!term) return res.json({ error: 'provide ?q=' });
    if (!existsSync(STORE_DIR)) return res.json({ term, results: [] });

    const results = [];
    for (const f of readdirSync(STORE_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      let content;
      try { content = readFileSync(path.join(STORE_DIR, f), 'utf8'); } catch { continue; }
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

  // Whether a uvx package installs and runs on this image.
  app.get('/diag/uvx', async (req, res) => {
    const pkg = (req.query.pkg || 'ha-mcp@7.8.1').toString().replace(/[^a-zA-Z0-9.@_-]/g, '');
    const py = (req.query.py || '').toString().replace(/[^0-9.]/g, '');
    const pyFlag = py ? `--python ${py} ` : '';
    const r = await runCmd(`timeout 230 uvx ${pyFlag}${pkg} --help 2>&1 | head -c 2500`, 240000);
    res.json({ pkg, py, result: r });
  });

  // Sessions as parsed from the store. ?id= dumps one; ?find= filters the list.
  app.get('/diag/sesslist', (req, res) => {
    if (req.query.id) return res.json({ id: req.query.id, items: parseSession(req.query.id.toString()) });
    let sessions = listSessions();
    if (req.query.find) {
      const needle = req.query.find.toString().toLowerCase();
      sessions = sessions.filter((s) => s.title.toLowerCase().includes(needle));
    }
    res.json({ store: STORE_DIR, active: runtime.activeSessionId, sessions });
  });

  // The raw on-disk store, for verifying where transcripts actually live.
  app.get('/diag/sessions', (_req, res) => {
    const candidates = [
      path.join(HOME_DIR, '.claude', 'projects'),
      path.join(CLAUDE_CONFIG_DIR, 'projects'),
    ];
    const out = { candidates: {}, sample: null };
    for (const dir of candidates) {
      if (!existsSync(dir)) { out.candidates[dir] = null; continue; }
      const projects = {};
      for (const proj of readdirSync(dir)) {
        const pdir = path.join(dir, proj);
        try {
          projects[proj] = readdirSync(pdir).filter((f) => f.endsWith('.jsonl')).map((f) => {
            const st = statSync(path.join(pdir, f));
            return { file: f, size: st.size, mtime: st.mtimeMs };
          });
        } catch { projects[proj] = '<unreadable>'; }
      }
      out.candidates[dir] = projects;

      if (!out.sample) {
        let newest = null;
        for (const [proj, files] of Object.entries(projects)) {
          if (!Array.isArray(files)) continue;
          for (const f of files) if (!newest || f.mtime > newest.mtime) newest = { ...f, proj };
        }
        if (newest) {
          const lines = readFileSync(path.join(dir, newest.proj, newest.file), 'utf8').split('\n').slice(0, 4);
          out.sample = { path: path.join(dir, newest.proj, newest.file), firstLines: lines };
        }
      }
    }
    res.json(out);
  });
}
