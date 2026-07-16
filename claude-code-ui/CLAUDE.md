# Claude Code UI — Home Assistant Add-on

A browser-based Claude Code interface running as an HA add-on. Provides a chat UI backed by the Claude Agent SDK with direct access to Home Assistant config and state.

## Architecture

```
browser  ←→  WebSocket  ←→  server/index.js  ←→  @anthropic-ai/claude-agent-sdk
                                  ↓
                          ha-ws-client (WebSocket tools)
                          ha-history / ha-stats (date-range WebSocket helpers)
                          ha-lovelace (dashboard WebSocket helper)
                          plugins/homeassistant-config/
```

- **`server/index.js`** — Express + WebSocket server; calls `query()` from Agent SDK; streams events to browser
- **`frontend/`** — Single-page chat UI (vanilla JS, no build step)
- **`run.sh`** — Add-on entrypoint; initialises `/data` environment, runs context generation, starts Node
- **`plugins/homeassistant-config/`** — Local plugin with SKILL.md and pre-save YAML validation hook
- **`scripts/`** — `ha-context.sh` (writes the generated HA context to `~/.claude/ha-context.md`), `browser-capture.sh` (auth flow URL capture), `ha-lovelace.cjs` / `ha-stats.cjs` / `ha-history.cjs` (Node WebSocket CLIs)

### Agent memory (CLAUDE.md)

`ha-context.sh` writes the live Home Assistant context to `~/.claude/ha-context.md` (i.e. `/data/home/.claude/ha-context.md`), regenerated on every start. `run.sh` seeds `~/.claude/CLAUDE.md` **once** with a `@ha-context.md` import line and never overwrites it, so the user's own instructions are user-editable and persist across restarts/updates (everything under `/data` is persistent). Claude Code resolves the `@ha-context.md` import relative to CLAUDE.md's directory.

## Deploy Workflow

```bash
# Copy to add-on directory on HA host
scp -P 222 -r claude-code-ui/ root@192.168.1.10:/addons/

# Same version — rebuild
ssh -p 222 root@192.168.1.10 "ha apps rebuild local_claude-code-ui"

# After bumping version in config.yaml — update
ssh -p 222 root@192.168.1.10 "ha apps update local_claude-code-ui"
```

SSH key: `~/.ssh/ha_claude`. Host: `192.168.1.10:222`. User: `root` (HA SSH add-on default).

To bust Docker layer cache for shell script changes, bump `ARG SCRIPTS_VER` in the Dockerfile.

## Environment

- **Platform**: Raspberry Pi 4 (aarch64), Home Assistant OS
- **`SUPERVISOR_TOKEN`**: Injected automatically by HA Supervisor; authenticates REST calls via `http://supervisor/core/api/`
- **`ANTHROPIC_CONFIG_DIR`**: `/data/.config/claude` — persists Claude auth credentials across restarts
- **`WORK_DIR`**: `/config` (HA config directory, mounted read-write)

## Authentication

Claude authenticates via device flow (`claude auth login`) or `ANTHROPIC_API_KEY` in add-on config. Credentials persist in `/data/.config/claude/.credentials.json`. The server checks this on connect and shows a login screen if unauthenticated.

## HA Tool Access

Three patterns for interacting with HA at runtime:

| Tool | Use case | Auth |
|------|----------|------|
| **ha-ws-client** | Entity states, service calls, templates, registry search, traces, recent history | `$SUPERVISOR_TOKEN` auto |
| **ha-history** / **ha-stats** | History / long-term statistics over a date range (`--days`, `--from`, `--to`) — Node helpers in `scripts/` wrapping `history/history_during_period` + `recorder/statistics_during_period` | `$SUPERVISOR_TOKEN` auto |
| **ha-lovelace** | Lovelace dashboards (list / get / save) over WebSocket | `$SUPERVISOR_TOKEN` auto |
| **REST curl** | States, services (`/api/...`) | `Authorization: Bearer $SUPERVISOR_TOKEN` |
| **Direct YAML edit** | YAML-mode dashboards & all config files in `/config` | file is on disk, no auth |

**Safety:** the agent is instructed (via `ha-context.sh` CLAUDE.md + the plugin SKILL.md) to never edit `/config/.storage/*` or the recorder DB without asking the user first — they need a restart, bypass validation, and corrupt easily.

Both `ha-ws-client` and `ha-lovelace` connect to `ws://supervisor/core/api/websocket` with `$SUPERVISOR_TOKEN`. `ha-lovelace` is a small `scripts/ha-lovelace.cjs` (the REST `/api/lovelace/*` endpoints 404 — Lovelace is WebSocket-only). Full command reference is in `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md`.

### Diagnostics

`GET /diag` runs a read-only auth/connectivity probe from inside the container: reports `$SUPERVISOR_TOKEN` presence, then exercises ha-ws-client, REST, and ha-lovelace with the live token. Use it to confirm what authenticates without theorising.

All diagnostic routes are **only registered when the `debug` add-on option is `true`** (default `false`); otherwise they're absent and requests fall through to the SPA. Enable via the add-on **Configuration** tab, or the Supervisor API (`POST /addons/local_claude-code-ui/options` with the full options object incl. `"debug": true`, then restart). The Supervisor token is available as `$SUPERVISOR_TOKEN` inside the SSH & Web Terminal add-on.

Endpoints:
- `GET /diag` — env + auth probes (ha-ws-client, REST, ha-lovelace) and the persisted-MCP extract from `~/.claude.json`.
- `GET /diag/config` — dumps the Claude config files the SDK may load settings/MCP from.
- `GET /diag/query?q=...` — runs a **real headless agent query** with tools auto-approved and returns the streamed events (init `mcp_servers`/`tools`, every `tool_use`/`tool_result`, text, result). This is the fastest way to emulate a user prompt and see which tools load and what errors come back.
- `GET /diag/conv` — inspect the persisted conversation (transcript length, resume id, file status). `?clear=1` clears it.
- `GET /diag/feed?q=...` — drive one real turn through the persistence path (records + saves + resumes), for verifying chat persistence without a browser.

```bash
IP=$(ha apps info local_claude-code-ui --raw-json | jq -r .data.ip_address)
curl http://$IP:7681/diag | jq .
curl "http://$IP:7681/diag/query?q=Tell%20me%20the%20car%20battery%20state" | jq '.events'
```

**ha-mcp has been removed entirely** — it was unreliable (broken WebSocket auth; mis-reports dashboards; the SDK doesn't invoke `canUseTool` for MCP tools so they bypass prompts). Use ha-ws-client + ha-history/ha-stats + ha-lovelace + direct YAML edits, which run as Bash/Edit calls and honour the permission mode. The `enable_ha_mcp` / `ha_token` add-on options are gone.

**Important — persisted MCP state:** the Claude CLI persists MCP servers into `~/.claude.json` (`projects["/config"].mcpServers`), and the SDK auto-loads them on every run. An early MCP-enabled build wrote a `home-assistant` server there, which kept loading and causing "Invalid authentication token" errors long after we stopped configuring it. `sanitizeMcpState()` in `server/index.js` strips persisted `mcpServers` (global + per-project) at startup so the add-on never loads a stale MCP server. **Do not remove it** even though we no longer configure any MCP servers ourselves.

### Other add-ons' configs (`/addon_configs`)

The `all_addon_configs:rw` map in `config.yaml` mounts every other add-on's config folder at `/addon_configs/<repo>_<slug>/`. HA folder maps are **static** (always mounted; can't be toggled per-option), so access is gated in the app instead: the `allow_addon_configs` option (default **false**) → `ALLOW_ADDON_CONFIGS` env → a **PreToolUse hook** (`ADDON_CONFIGS_HOOKS` in `server/index.js`) that returns `permissionDecision: 'deny'` for any tool call whose serialized input contains `/addon_configs`. A PreToolUse hook is used rather than `canUseTool` because it runs in **every** permission mode — including `auto`, which has no `canUseTool` — and its deny short-circuits the tool before it runs. The hook is only attached when access is disabled (no per-call overhead when enabled). When enabled, `ha-context.sh` appends a section telling Claude the folder exists and how it's laid out; when disabled it's not advertised at all.

## Conversation Persistence

There is one persistent conversation (single-user add-on). `server/index.js` keeps a global `conversation = { sessionId, transcript }` saved to `/data/conversation.json` (debounced), so the chat survives browser reconnects and add-on / HA restarts until the user hits **New chat** (`new_session` → `clearConversation` + broadcast `cleared`). On connect the server replays `{ type: 'history', items, running }`; the client rebuilds the DOM via `renderHistory`. Queries run on a module-level `activeQuery` AbortController — **not** tied to a connection — so navigating away mid-response doesn't cancel it (the run keeps recording, and `ws.close` no longer aborts). `sessionId` is used for SDK `resume`; a stale id is dropped on error so the next prompt starts fresh while keeping the visual transcript.

## Permission Modes

Selectable in the UI per-prompt; the **default for new chats** comes from the `default_permission_mode` add-on option (`DEFAULT_PERMISSION_MODE` → sent to the client in the `config` connect message; localStorage overrides it once the user picks one).

- **Ask** — `canUseTool` prompts the user for each tool call
- **Plan** — SDK-native plan mode (`permissionMode: 'plan'`): the model is restricted to read-only tools and proposes a plan. Routed through `canUseTool` too, which auto-allows read-only tools and only prompts on `ExitPlanMode` (the plan-approval step). Like `auto`, a run *started* in plan can't be live-switched.
- **Accept Edits** — file edits (`EDIT_TOOLS`) auto-approved, other tools prompt
- **Bypass** — all tools auto-approved (auto-allow `canUseTool`, not the SDK `bypassPermissions` mode, which the CLI refuses when running as root — it exits 1)
- **Auto** — a model classifier approves/denies each tool, no prompts (`permissionMode: 'auto'`, no `canUseTool`)

**Reasoning effort:** the Settings panel has an effort selector (Low→Max) sent as `effort` on the prompt; the server sets `opts.effort` only when a level is chosen (else the SDK model default, high). Higher effort means longer, quieter thinking — a common cause of the "chat looks stuck" perception.

## Auto-Continue on Usage Limit

When a **claude.ai subscription** hits its **5-hour** usage limit mid-run, the SDK emits a `rate_limit_event` with `status: 'rejected'`, `rateLimitType: 'five_hour'`, and a `resetsAt` epoch. If the **Auto-continue on limit** Settings toggle is on, the server persists that and resumes the conversation automatically once the limit resets. (This is a genuine, first-class SDK signal — not log-scraping.)

- **Subscription-only.** Gated on `isSubscriptionAuth()` (`!ANTHROPIC_API_KEY && .credentials.json` present). API-key auth surfaces plain 429s with no reset time to schedule against, so the toggle is shown disabled. The `rate_limit_event` itself is only emitted for subscription users.
- **5-hour only.** `seven_day`/`overage` rejections are broadcast (`rate_limit`) and logged but never auto-resumed — waiting out a week unattended is not the intent.
- **State is server-owned**, persisted to `/data/auto-continue.json` as `{ enabled, pending }`. The toggle is *not* localStorage (the resume must fire with **no browser open**). `enabled` is the user toggle; `pending` is a scheduled resume `{ resetsAt, rateLimitType, model, effort, permissionMode, attempts }`.
- **Survives restarts.** On boot, `loadAutoContinue()` + a re-arm block reschedule a saved `pending` (fires ~immediately if `resetsAt` already elapsed during downtime). `setTimeout`'s ~24.8-day ceiling covers a 5-hour wait.
- **Loop safety.** `attempts` is capped at `AUTO_CONTINUE_MAX_ATTEMPTS` (3): if a resume is immediately re-limited it backs off and eventually gives up (`auto_continue_gaveup`).
- **The resume** is a headless `runQuery` (a fake `{ readyState: 3 }` socket, shared `autoResumeState`) with a short "continue where you left off" prompt, reusing the interrupted run's model/effort/permission mode. If that run needs a **permission prompt** and clients are connected, `canUseTool` broadcasts it to any tab; if **no** client is connected it denies (rather than hanging) so the run ends cleanly. A manual prompt / new chat / session switch supersedes a pending resume (`cancelAutoContinue`).
- **Wire protocol:** server→client `auto_continue_pending` (banner + countdown), `auto_continue_resuming`, `auto_continue_cancelled`, `auto_continue_gaveup`, `auto_continue_state`, plus raw `rate_limit`; client→server `set_auto_continue`, `cancel_auto_continue`. Connect `config` carries `autoContinue` + `autoContinueSupported`.
- **Testing without a real limit:** `GET /diag/autocontinue?simulate=<seconds>` (debug option on) arms a resume that fires after N seconds against the active session, exercising the full schedule→resume path.

## Logging & the "chat hangs" symptom

Reported symptom: a response stops coming, then resumes minutes later (not a true hang — usually long silent thinking, a slow tool, a retry/backoff, or auto-compaction). Instrumentation added for it:
- **Server** (`server/index.js`): milestone logs always at INFO — query start (mode/effort/model/resume), result (duration/turns/cost), compaction, errors. A **stall watchdog** logs a WARN when no SDK event arrives for ≥20s during a run. Context usage is logged each turn (WARN ≥90%). The `verbose_logging` add-on option (`VERBOSE_LOGGING`) adds per-event DEBUG logs (each text/tool_use/tool_result). All go to the add-on log.
- **Frontend**: the Working indicator shows **elapsed seconds** (restarts each quiet stretch) and the context indicator turns amber→red with a `/compact` nudge as the window fills.
- **/compact echo**: slash-command runs are recorded in the transcript as user messages wrapped in `<command-name>…`/`<local-command-stdout>…`. `isCommandEcho()` in `lineToItems` filters them so `/compact` doesn't pollute the chat.

**Live mid-prompt switching:** ask/acceptEdits/bypass all route through a single `canUseTool` that reads the module-level `activePermMode` at call time, so changing the dropdown mid-run takes effect immediately (the client sends `set_perm_mode`). Switching to bypass/acceptEdits also auto-resolves any pending permission prompt (server emits `permission_resolved` so the UI dismisses the card). **Caveat:** `auto` is SDK-native with no `canUseTool`, so a run *started* in auto can't be live-switched — the change applies to the next prompt. `canUseTool` is also not invoked for external MCP server tools (none are configured now).

## Interactive Tools & Context Usage

- **AskUserQuestion** is added to `disallowedTools` so Claude never calls the structured tool. In SDK mode the subprocess handles AskUserQuestion internally (returning "The user did not answer") rather than routing it to the host, resulting in a silent failure. Disabling it causes Claude to ask questions in plain conversational text instead, which works reliably. The server still registers `onUserDialog` (and the frontend has a dialog overlay) in case a future SDK version routes interactive tools to the host.
- **Context indicator** uses `query.getContextUsage()` (cache-inclusive `totalTokens` / `maxTokens` / `autoCompactThreshold` / `isAutoCompactEnabled`), broadcast as `context_usage` after each result and after compaction. The frontend shows tokens and **% toward auto-compaction**. The old input+output math undercounted because it ignored `cache_read_input_tokens`.
- **Compaction** is handled by the SDK (auto + `/compact`); the server forwards the `system`/`compact_boundary` event as `compacted` so the UI shows a divider and refreshes the indicator.

## Key Files

| File | Purpose |
|------|---------|
| `config.yaml` | Add-on manifest, options schema |
| `build.yaml` | Docker build args (base image) |
| `Dockerfile` | Image build: Node, Agent SDK binary, ha-ws-client, ha-lovelace/ha-history/ha-stats wrappers, plugin |
| `run.sh` | Entrypoint: env init, packages, HA context, start server |
| `server/index.js` | WebSocket server, Agent SDK integration, permission handling |
| `frontend/index.html` | Chat UI shell |
| `frontend/app.js` | WebSocket client, message rendering |
| `frontend/styles.css` | Dark theme styles |
| `plugins/homeassistant-config/PLUGIN.md` | Plugin manifest |
| `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md` | HA YAML patterns + tool docs |
