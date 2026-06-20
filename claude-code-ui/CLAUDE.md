# Claude Code UI — Home Assistant Add-on

A browser-based Claude Code interface running as an HA add-on. Provides a chat UI backed by the Claude Agent SDK with direct access to Home Assistant config and state.

## Architecture

```
browser  ←→  WebSocket  ←→  server/index.js  ←→  @anthropic-ai/claude-agent-sdk
                                  ↓
                          ha-mcp (uvx, REST tools)
                          ha-ws-client (WebSocket tools)
                          plugins/homeassistant-config/
```

- **`server/index.js`** — Express + WebSocket server; calls `query()` from Agent SDK; streams events to browser
- **`frontend/`** — Single-page chat UI (vanilla JS, no build step)
- **`run.sh`** — Add-on entrypoint; initialises `/data` environment, runs context generation, starts Node
- **`plugins/homeassistant-config/`** — Local plugin with SKILL.md and pre-save YAML validation hook
- **`scripts/`** — `ha-context.sh` (writes CLAUDE.md to /config), `browser-capture.sh` (auth flow URL capture)

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
| **ha-ws-client** | Entity states, service calls, templates, registry search, traces, history | `$SUPERVISOR_TOKEN` auto |
| **ha-lovelace** | Lovelace dashboards (list / get / save) over WebSocket | `$SUPERVISOR_TOKEN` auto |
| **REST curl** | States, services (`/api/...`) | `Authorization: Bearer $SUPERVISOR_TOKEN` |
| **Direct YAML edit** | YAML-mode dashboards & all config files in `/config` | file is on disk, no auth |

Both `ha-ws-client` and `ha-lovelace` connect to `ws://supervisor/core/api/websocket` with `$SUPERVISOR_TOKEN`. `ha-lovelace` is a small `scripts/ha-lovelace.cjs` (the REST `/api/lovelace/*` endpoints 404 — Lovelace is WebSocket-only). Full command reference is in `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md`.

### Diagnostics

`GET /diag` runs a read-only auth/connectivity probe from inside the container: reports `ENABLE_HA_MCP` and token presence, then exercises ha-ws-client, REST, and ha-lovelace with the live `$SUPERVISOR_TOKEN`. Use it to confirm what authenticates without theorising.

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

**ha-mcp is disabled by default** (`enable_ha_mcp: false`) and was found unreliable (broken WebSocket auth; mis-reports dashboards; the SDK doesn't invoke `canUseTool` for MCP tools so they bypass prompts). Prefer ha-ws-client + ha-lovelace + direct YAML edits, which run as Bash/Edit calls and honour the permission mode.

**Important — persisted MCP state:** the Claude CLI persists MCP servers into `~/.claude.json` (`projects["/config"].mcpServers`), and the SDK auto-loads them on every run *regardless of `ENABLE_HA_MCP`*. An early MCP-enabled build wrote a `home-assistant` server there, which kept loading and causing the "Invalid authentication token" errors long after we disabled the flag. `sanitizeMcpState()` in `server/index.js` strips persisted `mcpServers` (global + per-project) at startup so `opts.mcpServers` is the sole source of truth. Do not remove it.

## Conversation Persistence

There is one persistent conversation (single-user add-on). `server/index.js` keeps a global `conversation = { sessionId, transcript }` saved to `/data/conversation.json` (debounced), so the chat survives browser reconnects and add-on / HA restarts until the user hits **New chat** (`new_session` → `clearConversation` + broadcast `cleared`). On connect the server replays `{ type: 'history', items, running }`; the client rebuilds the DOM via `renderHistory`. Queries run on a module-level `activeQuery` AbortController — **not** tied to a connection — so navigating away mid-response doesn't cancel it (the run keeps recording, and `ws.close` no longer aborts). `sessionId` is used for SDK `resume`; a stale id is dropped on error so the next prompt starts fresh while keeping the visual transcript.

## Permission Modes

Selectable in the UI per-prompt (mapped to SDK `permissionMode` in `server/index.js`):
- **Ask** — `canUseTool` callback prompts the user for each tool call (default)
- **Auto** — a model classifier approves/denies each tool automatically, no prompts (`permissionMode: 'auto'`); `canUseTool` is not set
- **Accept Edits** — file edits auto-approved, other tools prompt (`acceptEdits`)
- **Bypass** — all tools auto-approved. Implemented via an auto-allow `canUseTool` (not the SDK `bypassPermissions` mode, which the CLI refuses when running as root — it exits 1)

Note: `canUseTool` is not invoked for external MCP server tools (ha-mcp); those run without prompting regardless of mode — another reason ha-mcp is disabled by default.

## Key Files

| File | Purpose |
|------|---------|
| `config.yaml` | Add-on manifest, options schema |
| `build.yaml` | Docker build args (base image) |
| `Dockerfile` | Image build: Node, Agent SDK binary, ha-ws-client, uvx/ha-mcp, plugin |
| `run.sh` | Entrypoint: env init, packages, HA context, start server |
| `server/index.js` | WebSocket server, Agent SDK integration, permission handling |
| `frontend/index.html` | Chat UI shell |
| `frontend/app.js` | WebSocket client, message rendering |
| `frontend/styles.css` | Dark theme styles |
| `plugins/homeassistant-config/PLUGIN.md` | Plugin manifest |
| `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md` | HA YAML patterns + tool docs |
