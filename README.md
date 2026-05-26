# Claude Code UI for Home Assistant

A Home Assistant add-on that provides Claude Code with a **mobile-friendly web UI**, replacing the raw terminal interface with a modern chat + file explorer experience.

## What this is

This add-on combines two projects:

- **[heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons)** — the Home Assistant integration layer: pre-installed Claude Code CLI, HA context generation (auto-populates a `CLAUDE.md` with your HA entities, add-ons, and errors), and the `ha-mcp` server so Claude can call HA services directly. This project owes its entire HA integration to that work.

- **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** — a modern React + Node.js web UI for Claude Code, with a responsive layout designed to work on mobile. It provides a proper chat interface, file explorer, git integration, and an embedded terminal.

The result: Claude Code running inside your Home Assistant, accessible from your phone with a proper interface.

## Features

- 📱 **Mobile-first UI** — works well in the HA Android/iOS app
- 🏠 **HA-aware** — Claude automatically loads your HA version, entities, add-ons, and recent errors at session start
- 🔧 **MCP integration** — Claude can call HA services directly via the `ha-mcp` MCP server
- 🔐 **HA auth** — protected by Home Assistant's ingress authentication; no separate login
- 💾 **Persistent sessions** — credentials and session history survive add-on restarts
- 🏗️ **Multi-arch** — supports amd64, aarch64, and armv7

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Click the three-dot menu → **Repositories**
3. Add: `https://github.com/xionic/home-assistant-claude-code`
4. Find **Claude Code UI** in the store and install it
5. Open the add-on and complete Claude's OAuth login on first run

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `ha_smart_context` | `true` | Generate a `CLAUDE.md` with HA system info that Claude loads each session |
| `enable_ha_mcp` | `true` | Wire up the ha-mcp MCP server so Claude can call HA services |
| `persistent_apk_packages` | `[]` | Alpine packages to install on each startup |
| `persistent_pip_packages` | `[]` | Python packages to install on each startup |

## Architecture

```
Docker container (Alpine, HA base image)
├── Claude Code CLI        (@anthropic-ai/claude-code)
├── claudecodeui server    (@cloudcli-ai/cloudcli)
│   ├── Express/WS backend (spawns claude subprocesses)
│   └── React frontend     (mobile-responsive)
├── scripts/
│   ├── ha-context.sh      (generates CLAUDE.md from HA Supervisor API)
│   └── setup-ha-mcp.sh    (wires up HA MCP server)
└── run.sh

HA Supervisor → Ingress proxy → port 7681 → claudecodeui UI
```

## Credits

- [heytcass](https://github.com/heytcass) for the original Claude Terminal add-on and all the HA integration work (MIT license)
- [siteboon](https://github.com/siteboon) for claudecodeui (AGPL-3.0 license)
- [Anthropic](https://www.anthropic.com) for Claude Code

## License

AGPL-3.0 (inherited from claudecodeui). See [LICENSE](LICENSE).

The HA integration scripts in `claude-code-ui/scripts/` are adapted from
[heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons)
under the MIT license — original copyright remains with that project.
