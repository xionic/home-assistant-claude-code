<img src="claude-code-ui/icon.png" width="84" align="right" alt="Claude">

# Claude Code UI for Home Assistant

A Home Assistant add-on that runs **Claude Code as a mobile-friendly chat** in your
browser, with direct access to your Home Assistant configuration and live state.
It's a self-contained chat UI backed by the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk),
running inside HA and reachable from your phone through the HA app.

## Features

- 📱 **Mobile-first chat UI** — clean vanilla-JS interface (no build step), works well in the HA Android/iOS app
- 💬 **Multi-session** — browse, resume, and delete past conversations. Built directly on Claude Code's own on-disk session store (`~/.claude/projects`), so sessions are interchangeable with the Claude CLI
- 🔎 **Find in chat** — header search button, `/find`, or Ctrl/Cmd+F, with match count, next/previous, and highlighting
- ⌨️ **Slash commands** with autocomplete — `/new`, `/clear`, `/usage`, `/resume`, `/find`, plus any plugin commands
- 🧠 **HA-aware context** — auto-loads your HA version, entities, add-ons, and recent errors into Claude's context each session
- 🔧 **Live HA tools** — `ha-ws-client` (states, service calls, templates, history/stats/logbook, registry) and `ha-lovelace` (dashboard get/list/save) talk to HA over the Supervisor connection, authenticated automatically with `$SUPERVISOR_TOKEN` — **no token setup required**
- 🔐 **Permission modes** — Ask / Auto (model classifier) / Accept edits / Bypass; your choice persists
- 🤖 **Model selection** — switch between Opus / Sonnet / Haiku; the UI shows the model actually in use
- ⏳ **Live feedback** — a "working" indicator while Claude runs and a stop button to interrupt
- 🔒 **HA ingress auth** — protected by Home Assistant; no separate login. Claude credentials (subscription or API key) persist across restarts
- 🏗️ **Multi-arch** — aarch64 and amd64

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Three-dot menu → **Repositories** → add `https://github.com/xionic/home-assistant-claude-code`
3. Find **Claude Code UI** in the store and install it
4. Start it, open the UI, and sign in with your Anthropic account (or set an API key in the options)

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `anthropic_api_key` | `""` | Optional. Use an API key instead of signing in with a Claude subscription |
| `ha_token` | `""` | Optional long-lived token. Only needed if you enable `ha-mcp`; not required for normal use |
| `ha_smart_context` | `true` | Generate a `CLAUDE.md` with HA system info that Claude loads each session |
| `enable_ha_mcp` | `false` | Optional `ha-mcp` MCP server. **Off by default** — `ha-ws-client`/`ha-lovelace` are used instead (see below) |
| `bypass_permissions` | `false` | Default the session to auto-approving tools |
| `debug` | `false` | Expose read-only `/diag` diagnostic endpoints on the internal port |
| `persistent_apk_packages` | `[]` | Alpine packages to install on each startup |
| `persistent_pip_packages` | `[]` | Python packages to install on each startup |

## How Claude talks to Home Assistant

Claude uses two pre-installed CLI tools (via Bash) plus the Supervisor REST API,
all authenticated automatically with `$SUPERVISOR_TOKEN`:

- **`ha-ws-client`** — entity states, service calls, Jinja templates, history / statistics / logbook, and registry search over the HA WebSocket API.
- **`ha-lovelace`** — Lovelace dashboard `list` / `get` / `save` over the WebSocket API (the REST `/api/lovelace/*` endpoints don't exist on modern HA).
- **YAML editing** — Claude can read and edit your `/config` files directly.

`ha-mcp` is disabled by default: its WebSocket auth was unreliable with the
add-on token, and MCP tool calls bypass the permission UI. The CLI tools above
run as normal Bash calls, so they authenticate cleanly **and** respect your
chosen permission mode.

## Architecture

```
browser  ⇄  WebSocket  ⇄  server/index.js  (Node + @anthropic-ai/claude-agent-sdk)
                                 ├── ha-ws-client            (HA WebSocket API)
                                 ├── ha-lovelace             (dashboards)
                                 ├── plugins/homeassistant-config  (skill + YAML validation hook)
                                 └── Claude Code session store  (~/.claude/projects/*.jsonl)

HA Supervisor → Ingress proxy → port 7681 → chat UI
```

## Credits

- [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) — the original Claude Terminal add-on and HA integration patterns the context generation is adapted from (MIT)
- [schoolboyqueue](https://github.com/schoolboyqueue/home-assistant-blueprints) — the `ha-ws-client` Go binary
- [Anthropic](https://www.anthropic.com) — Claude and the Claude Agent SDK

## License

See [LICENSE](LICENSE). HA integration scripts in `claude-code-ui/scripts/` are
adapted from [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons)
under the MIT license; original copyright remains with that project.
