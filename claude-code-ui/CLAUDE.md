# Claude Code UI — Home Assistant App

A browser-based Claude Code interface running as an HA app. Provides a chat UI backed by the Claude Agent SDK with direct access to Home Assistant config and state.

## Architecture

```
browser  ←→  WebSocket  ←→  server/index.js  ←→  @anthropic-ai/claude-agent-sdk
                                  ↓
                          ha-ws-client (third-party Go binary; states, calls, templates)
                          ha-tools (this app's helpers: history / stats / lovelace / logs)
                          plugins/homeassistant-config/
```

- **`server/index.js`** — Express + WebSocket server; calls `query()` from Agent SDK; streams events to browser
- **`frontend/`** — Single-page chat UI (vanilla JS, no build step)
- **`run.sh`** — App entrypoint; initialises `/data` environment, runs context generation, starts Node
- **`plugins/homeassistant-config/`** — Local plugin with SKILL.md and pre-save YAML validation hook
- **`scripts/`** — `ha-context.sh` (writes the generated HA context to `~/.claude/ha-context.md`), `browser-capture.sh` (auth flow URL capture), and the `ha-tools` helper suite:
  - `ha-tools.sh` — dispatcher; the single entry point (see below)
  - `ha-tools.cjs` — the subcommands (`history`, `stats`, `timeline`, `lovelace`, `automation`, `config-check`, `reload`, `trace-watch`)
  - `lib/ha-ws.cjs` — shared connect/auth/request client
  - `lib/ha-time.cjs` — one clock for all output (see "Time" below)
  - `lib/ha-rest.cjs` — the few Supervisor REST endpoints with no WebSocket equivalent
  - `ha-logs.sh` — Supervisor journald log reader, reached as `ha-tools logs`

### Agent memory (CLAUDE.md)

`ha-context.sh` writes the live Home Assistant context to `~/.claude/ha-context.md` (i.e. `/data/home/.claude/ha-context.md`), regenerated on every start. `run.sh` seeds `~/.claude/CLAUDE.md` **once** with a `@ha-context.md` import line and never overwrites it, so the user's own instructions are user-editable and persist across restarts/updates (everything under `/data` is persistent). Claude Code resolves the `@ha-context.md` import relative to CLAUDE.md's directory.

## Deploy Workflow

SSH key: `~/.ssh/ha_claude`. Host: `192.168.1.10:222`. **User: `hassio`**, not `root` —
this HA install uses the community "Advanced SSH & Web Terminal" app (the
official "Terminal & SSH" app has no protection-mode toggle). `hassio` has
genuine passwordless root via `wheel` (`sudo -n whoami` → `root`), so anything
needing root goes through `sudo`, not a different login.

```bash
# Copy to app directory on HA host. -O forces the legacy SCP protocol — this
# app has no SFTP subsystem, so a modern scp fails with "Connection closed"
# without it. /addons/ itself is root-owned (mkdir there needs sudo), but the
# existing claude-code-ui/ dir is hassio-owned, so copy INTO it, not onto
# /addons/ directly.
scp -O -P 222 -r claude-code-ui/* hassio@192.168.1.10:/addons/claude-code-ui/

# scp MERGES, it doesn't mirror — files removed locally since the last deploy
# stay on the host unless deleted explicitly. Diff scripts/ against the repo
# after a deploy, or track deletions by hand as below.
ssh -p 222 hassio@192.168.1.10 "rm -f /addons/claude-code-ui/scripts/<removed-file>"

# If scp reports "Permission denied" on individual files: a previous rebuild
# (which runs as root) left some files root-owned inside the hassio-owned
# directory. Fix ownership, then retry the copy:
ssh -p 222 hassio@192.168.1.10 "sudo chown -R hassio:hassio /addons/claude-code-ui"

# IMPORTANT: strip the `image:` key from the REMOTE copy so the Supervisor
# builds from the Dockerfile. config.yaml ships `image:` for STORE installs
# (prebuilt image), but with it present `need_build` is false (ATTR_IMAGE not
# in data) and `ha apps rebuild` errors (AppRebuildImageBasedError) / `update`
# pulls the published image instead of your local changes.
ssh -p 222 hassio@192.168.1.10 "sed -i '/^image:/d' /addons/claude-code-ui/config.yaml"

# `ha` CLI calls need a LOGIN shell. Non-interactive `ssh host "ha ..."` doesn't
# source the profile script that exports SUPERVISOR_TOKEN, so a bare `ha`
# command fails `unauthorized: missing or invalid API token` even with
# protection mode off and everything else correct. Wrap every `ha` call:
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps rebuild local_claude-code-ui'"   # same version
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps update local_claude-code-ui'"    # after a version bump
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps info local_claude-code-ui'"      # state / version
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps logs local_claude-code-ui'"      # startup / runtime logs

# To shell into the running container: `ha apps exec` is not a real subcommand
# (it silently falls through to something else). Use docker directly — the
# container is named app_<slug>, not addon_<slug>:
ssh -p 222 hassio@192.168.1.10 "sudo docker exec app_local_claude-code-ui ha-tools --help"
```

To bust Docker layer cache for shell script changes, bump `ARG SCRIPTS_VER` in the Dockerfile.

Rebuilding restarts the app — any in-progress Claude Code UI session on HA drops.

## Releasing

**Do not bump `version:` on every commit.** Home Assistant reads that value
straight off `master` to decide whether an update is available, so bumping it
tells every installed user there's a new release — and if CI hasn't published a
matching image tag yet, their update *fails*. The version and the published
image must stay in lockstep.

The rule is therefore: **`version:` in `config.yaml` names the latest released
image; a bump *is* the release.** Ordinary commits leave it alone. CI enforces
this — it runs on every push touching `claude-code-ui/**`, but the `version` job
checks GHCR and skips the build entirely when that version is already published,
so a published tag is never silently overwritten.

Day to day, land changes with the version untouched and add them under
`## Unreleased` at the top of `CHANGELOG.md`. To cut a release:

1. Rename the `## Unreleased` heading to the new version number
2. Bump `version:` in `config.yaml` to match
3. Commit and push — CI sees the new version and publishes it

`workflow_dispatch` takes a `force` input to rebuild and overwrite an
already-published version; use it only to repair a broken publish.

## Prebuilt images (CI)

`.github/workflows/build.yml` builds a multi-arch image with the Home Assistant
`builder` composite actions (`prepare-multi-arch-matrix` → `build-image` →
`publish-multi-arch-manifest`, pinned to `2026.06.0`) and pushes it to
`ghcr.io/xionic/claude-code-ui:<version>` + `:latest` — but only when that
version isn't already published (see **Releasing** above). The new builder does **not** read
`build.yaml`, so the workflow passes `BUILD_FROM` per arch. Store installs pull
this image (via the `image:` key in config.yaml); local dev builds from source
after the `sed` strip above. **One-time GHCR setup:** after the first successful
run, set the `claude-code-ui` package visibility to **public** so users can pull
anonymously.

## Environment

- **Platform**: Raspberry Pi 4 (aarch64), Home Assistant OS
- **`SUPERVISOR_TOKEN`**: Injected automatically by HA Supervisor; authenticates REST calls via `http://supervisor/core/api/`
- **`ANTHROPIC_CONFIG_DIR`**: `/data/.config/claude` — persists Claude auth credentials across restarts
- **`WORK_DIR`**: `/config` (HA config directory, mounted read-write)

### Folder maps

`config.yaml` uses the current Supervisor map types with **explicit `path` pins**:
`homeassistant_config` → `/config` (its default is `/homeassistant`) and
`all_app_configs` → `/addon_configs` (its default is `/app_configs`). The pins are
deliberate — `WORK_DIR`, the persisted Claude session keys (`~/.claude.json` is
keyed on the project dir `/config`), the `/addon_configs` guard in
`server/index.js`, and the ESPHome fallback in `run.sh` are all written against
these paths, so taking the new defaults would be a breaking change, not a rename.
The legacy names (`config`, `all_addon_configs`) still work but log deprecation
advisories; `all_app_configs` requires **Supervisor 2026.07+**.

## Authentication

Claude authenticates via device flow (`claude auth login`) or `ANTHROPIC_API_KEY` in app config. Credentials persist in `/data/.config/claude/.credentials.json`. The server checks this on connect and shows a login screen if unauthenticated.

## HA Tool Access

Patterns for interacting with HA at runtime:

| Tool | Use case | Auth |
|------|----------|------|
| **ha-ws-client** | Entity states, service calls, templates, registry search, traces, recent history | `$SUPERVISOR_TOKEN` auto |
| **ha-tools history** / **stats** (`ha-history`, `ha-stats`) | History / long-term statistics over a date range (`--days`, `--from`, `--to`) — wraps `history/history_during_period` + `recorder/statistics_during_period` | `$SUPERVISOR_TOKEN` auto |
| **ha-tools timeline** (`ha-timeline`) | Several entities' state changes merged onto one clock (`--between HH:MM-HH:MM`) — the core automation-debugging move | `$SUPERVISOR_TOKEN` auto |
| **ha-tools automation** | `list` / `show` (config HA has loaded) / `yaml` (its block in `automations.yaml`, numbered) | `$SUPERVISOR_TOKEN` auto |
| **ha-tools config-check** / **reload** | Validate config (exit 1 if invalid) then reload a domain — REST-only, previously hand-rolled curl | `$SUPERVISOR_TOKEN` auto |
| **ha-tools trace-watch** | Block until an automation actually fires, then report the trace (incl. condition-blocked runs) | `$SUPERVISOR_TOKEN` auto |
| **ha-tools lovelace** (`ha-lovelace`) | Lovelace dashboards (list / get / save / create / delete) over WebSocket | `$SUPERVISOR_TOKEN` auto |
| **ha-tools logs** (`ha-logs`) | Core / host / Supervisor / per-app logs via the Supervisor journald endpoints | `$SUPERVISOR_TOKEN` auto |
| **REST curl** | States, services (`/api/...`) | `Authorization: Bearer $SUPERVISOR_TOKEN` |
| **Direct YAML edit** | YAML-mode dashboards & all config files in `/config` | file is on disk, no auth |

**Safety:** the agent is instructed (via `ha-context.sh` CLAUDE.md + the plugin SKILL.md) to never edit `/config/.storage/*` or the recorder DB without asking the user first — they need a restart, bypass validation, and corrupt easily.

### ha-tools

`ha-tools` is this app's own helpers behind one entry point — `history`, `stats`,
`lovelace`, `logs`, plus `ws` as a passthrough to the ha-ws-client binary, so
`ha-tools --help` maps every HA command available in the container.

Each subcommand is **also** installed under its own name (`ha-history`,
`ha-stats`, `ha-lovelace`, `ha-logs`). Those are symlinks back to
`scripts/ha-tools.sh`, which reads `argv[0]` to pick the subcommand — one
implementation, two spellings, so they can't drift apart. Usage text echoes
whichever name was used (via `$HA_TOOLS_CMD`). Keeping the individual names
matters because they're what the SKILL.md and generated context teach, and
they're the names already in users' habits.

The WebSocket subcommands share `scripts/lib/ha-ws.cjs`, which owns the connect →
`auth_required` → `auth_ok` handshake and turns each command into a promise keyed
on the message id. Add a new WebSocket helper by adding a function to
`ha-tools.cjs` — not another top-level script.

#### Design rules (the consumer is an agent, not a person)

These came out of a real debugging session's feedback and are worth holding to,
because the failure modes are asymmetric: a human discards a bad diagnostic, an
agent believes it and spends three tool calls acting on it.

- **Never state an inferred cause as fact.** Say what failed
  (`websocket automation/config failed (…)`), not what you guess caused it. The
  upstream `ha-ws-client automation-config` announces "blueprint automation with
  no stored traces" from a branch that can only run when the automation is *not*
  a blueprint, and while traces exist — that message cost an agent several calls.
- **Empty is `[]`, broken is a non-zero exit.** `success: true` with a `null`
  payload is indistinguishable from a failed query, so an agent abandons the tool.
  `timeline` goes further and names entities that returned nothing at all, since
  "no events" and "you typo'd the entity_id" otherwise look identical.
- **Output shape is an API.** Flat rows with a header, or JSON with a documented
  top level. If the shape is unknown-nested, the caller writes a recursive walker
  to find the payload — a whole tool call spent on plumbing.
- **Do the plumbing here.** Merging several entities' histories onto one clock is
  the common debugging move, so it's `timeline`, not a script the agent rewrites
  each session.

#### Time

`lib/ha-time.cjs` is the only place that formats a timestamp. Everything prints
Home Assistant's configured timezone (fetched per-run via `get_config`) with an
explicit offset — `2026-08-12 23:27:42+01:00` — and `--utc` opts out.

The container clock is **UTC and never inherits HA's timezone**, so `new Date()`
formatting would silently shift every reported time by the user's offset. HA also
hands out three formats depending on the API — epoch floats (history), UTC ISO
(state attributes), local (`now()` in templates) — and an agent doing arithmetic
across two of them gets it wrong quietly. `toMillis()` normalises all three.

`ha-ws-client` is deliberately **not** absorbed: it's a third-party MIT Go binary
([schoolboyqueue/home-assistant-blueprints](https://github.com/schoolboyqueue/home-assistant-blueprints),
source at `scripts/ha-ws-client-go/`), downloaded per-arch in the Dockerfile.
Vendoring it would mean owning ~30 Go files and cross-compilation for no gain.

Both it and the WebSocket subcommands connect to
`ws://supervisor/core/api/websocket` with `$SUPERVISOR_TOKEN`. Lovelace is
WebSocket-only (the REST `/api/lovelace/*` endpoints 404). Full command reference
is in `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md`.

### Logs — journald only (HA 2025.11+)

**`/config/home-assistant.log` no longer exists** on HAOS/Supervised, and the Core
REST endpoint **`/api/error_log` was removed with it** — it returns 404 while
remaining listed in the HA developer docs, so it looks available and isn't.
Verified against Core 2026.8.1: `/api/config` and `/api/states` answer 401
unauthenticated (route present) while `/api/error_log` answers 404, same as a
nonexistent route.

Logs now come from the Supervisor's journald endpoints, which need `hassio_api`
(config.yaml grants it): `core/logs`, `host/logs`, `supervisor/logs`,
`addons/self/logs`, `host/logs/identifiers[/<id>]`, `host/logs/boots`. They take
`?lines=N`, `?boot=N`, `?verbose`, `?follow`, return **plain text**, not JSON,
and **colour it with ANSI escapes** — strip with `sed 's/\x1b\[[0-9;]*m//g'` or
the codes land in whatever you generate. `scripts/ha-logs.sh` (exposed as
`ha-logs`) wraps all of this; `section_recent_errors()` in `ha-context.sh` uses
`core/logs` for the startup context.

**Validate on the HTTP status, never on the body.** This endpoint's removal went
unnoticed for months precisely because `section_recent_errors()` only checked for
*empty* output: the body `404: Not Found` is short, non-empty, plausible text, so
it was pasted into Claude's context as though it were the error log. Content
sniffing can't fix that either — only Core/host/Supervisor logs are
timestamp-first; an app's log is raw container stdout with no guaranteed shape.

### Diagnostics

`GET /diag` runs a read-only auth/connectivity probe from inside the container: reports `$SUPERVISOR_TOKEN` presence, then exercises ha-ws-client, REST, and ha-lovelace with the live token. Use it to confirm what authenticates without theorising.

All diagnostic routes are **only registered when the `debug` app option is `true`** (default `false`); otherwise they're absent and requests fall through to the SPA. Enable via the app **Configuration** tab, or the Supervisor API (`POST /addons/local_claude-code-ui/options` with the full options object incl. `"debug": true`, then restart). The Supervisor token is available as `$SUPERVISOR_TOKEN` inside the SSH & Web Terminal app.

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

**ha-mcp has been removed entirely** — it was unreliable (broken WebSocket auth; mis-reports dashboards; the SDK doesn't invoke `canUseTool` for MCP tools so they bypass prompts). Use ha-ws-client + ha-history/ha-stats + ha-lovelace + direct YAML edits, which run as Bash/Edit calls and honour the permission mode. The `enable_ha_mcp` / `ha_token` app options are gone.

**Important — persisted MCP state:** the Claude CLI persists MCP servers into `~/.claude.json` (`projects["/config"].mcpServers`), and the SDK auto-loads them on every run. An early MCP-enabled build wrote a `home-assistant` server there, which kept loading and causing "Invalid authentication token" errors long after we stopped configuring it. `sanitizeMcpState()` in `server/index.js` strips persisted `mcpServers` (global + per-project) at startup so the app never loads a stale MCP server. **Do not remove it** even though we no longer configure any MCP servers ourselves.

### Other apps' configs (`/addon_configs`)

The `all_app_configs` map in `config.yaml` mounts every other app's config folder at `/addon_configs/<repo>_<slug>/`. HA folder maps are **static** (always mounted; can't be toggled per-option), so access is gated in the app instead: the `allow_addon_configs` option (default **false**) → `ALLOW_ADDON_CONFIGS` env → a **PreToolUse hook** (`ADDON_CONFIGS_HOOKS` in `server/index.js`) that returns `permissionDecision: 'deny'` for any tool call whose serialized input contains `/addon_configs`. A PreToolUse hook is used rather than `canUseTool` because it runs in **every** permission mode — including `auto`, which has no `canUseTool` — and its deny short-circuits the tool before it runs. The hook is only attached when access is disabled (no per-call overhead when enabled). When enabled, `ha-context.sh` appends a section telling Claude the folder exists and how it's laid out; when disabled it's not advertised at all.

## Conversation Persistence

There is one persistent conversation (single-user app). `server/index.js` keeps a global `conversation = { sessionId, transcript }` saved to `/data/conversation.json` (debounced), so the chat survives browser reconnects and app / HA restarts until the user hits **New chat** (`new_session` → `clearConversation` + broadcast `cleared`). On connect the server replays `{ type: 'history', items, running }`; the client rebuilds the DOM via `renderHistory`. Queries run on a module-level `activeQuery` AbortController — **not** tied to a connection — so navigating away mid-response doesn't cancel it (the run keeps recording, and `ws.close` no longer aborts). `sessionId` is used for SDK `resume`; a stale id is dropped on error so the next prompt starts fresh while keeping the visual transcript.

## Permission Modes

Selectable in the UI per-prompt; the **default for new chats** comes from the `default_permission_mode` app option (`DEFAULT_PERMISSION_MODE` → sent to the client in the `config` connect message; localStorage overrides it once the user picks one).

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
- **When it's off, the limit is still surfaced.** `autoContinue.offer` (persisted alongside `enabled`/`pending`) records a limit that stopped a run while nothing could be scheduled. The client shows the reset time and a **Resume automatically** button; pressing it just sends `set_auto_continue`, and the server schedules *that* offer rather than only affecting the next limit. An offer is dropped on a new prompt / new session / session switch, or once `resetsAt` is more than `LIMIT_OFFER_GRACE_MS` past (`liveLimitOffer()`).
- **Wire protocol:** server→client `auto_continue_pending` (banner + countdown), `auto_continue_resuming`, `auto_continue_cancelled`, `auto_continue_gaveup`, `auto_continue_state`, `limit_notice` (the in-transcript note at the point the run stopped), `limit_offer` / `limit_offer_cleared`, plus raw `rate_limit`; client→server `set_auto_continue`, `cancel_auto_continue`. Connect `config` carries `autoContinue` + `autoContinueSupported`, and replays `auto_continue_pending` or `limit_offer`.
- **Testing without a real limit:** `GET /diag/autocontinue?simulate=<seconds>` (debug option on) arms a resume that fires after N seconds against the active session, exercising the full schedule→resume path.
- **A rejection can still throw, and the throw lies.** Confirmed live: `rate_limit_event(status:'rejected')` fires (setting `limitHit`) — then the query still emits a `'result'` event claiming `subtype:'success'` (cost $0, 1 turn) — then the async generator *throws*, landing in the `catch` block with `err.message` like `"Claude Code returned an error result: You've hit your session limit · resets 1am (Europe/London)"`. None of that later noise is trustworthy: `limitHit`, set from the real `rate_limit_event`, is. So once `limitHit` is set for a run, the `'result'` handler no longer touches an `endedSuccessfully` flag (removed — a `'success'` subtype can't override a rejection that already happened), and the `catch` block skips both the generic `error` broadcast (the `finally` block's `limit_notice` already explains it) **and** the stale-resume-id drop (`resuming` branch) — that drop used to fire here every time, silently swapping `activeSessionId` to `null` so the *next* prompt started a brand-new session instead of resuming the interrupted one. Nothing was actually lost (the old transcript is still on disk, just no longer `activeSessionId`, findable in the session list), but it read as if the conversation had vanished.

## Logging & the "chat hangs" symptom

Reported symptom: a response stops coming, then resumes minutes later (not a true hang — usually long silent thinking, a slow tool, a retry/backoff, or auto-compaction). Instrumentation added for it:
- **Server** (`server/index.js`): milestone logs always at INFO — query start (mode/effort/model/resume), result (duration/turns/cost), compaction, errors. A **stall watchdog** logs a WARN when no SDK event arrives for ≥20s during a run. Context usage is logged each turn (WARN ≥90%). The `verbose_logging` app option (`VERBOSE_LOGGING`) adds per-event DEBUG logs (each text/tool_use/tool_result). All go to the app log.
- **Frontend**: the Working indicator shows **elapsed seconds** (restarts each quiet stretch) and the context indicator turns amber→red with a `/compact` nudge as the window fills.
- **/compact echo**: slash-command runs are recorded in the transcript as user messages wrapped in `<command-name>…`/`<local-command-stdout>…`. `isCommandEcho()` in `lineToItems` filters them so `/compact` doesn't pollute the chat.

**Live mid-prompt switching:** ask/acceptEdits/bypass all route through a single `canUseTool` that reads the module-level `activePermMode` at call time, so changing the dropdown mid-run takes effect immediately (the client sends `set_perm_mode`). Switching to bypass/acceptEdits also auto-resolves any pending permission prompt (server emits `permission_resolved` so the UI dismisses the card). **Caveat:** `auto` is SDK-native with no `canUseTool`, so a run *started* in auto can't be live-switched — the change applies to the next prompt. `canUseTool` is also not invoked for external MCP server tools (none are configured now).

## Interactive Tools & Context Usage

- **AskUserQuestion** is intercepted before the tool runs, and never executes. The SDK's own dialog transport is not the route it takes: the tool call completes inside the CLI subprocess with a canned "The user did not answer the questions." and no `request_user_dialog` is ever sent, whatever `supportedDialogKinds`/`toolConfig` declare. (That silent failure is why the tool used to be in `disallowedTools`.) Instead:
  - `canUseTool` short-circuits `AskUserQuestion`, emits the existing `user_dialog` message, and turns the answer into a **`deny` whose message is the user's answer** — `canUseTool` has no "succeeded with this result" shape, and a denial's message is what reaches the model as the tool result. See `formatQuestionDenial()`.
  - `auto` mode has no `canUseTool`, so there the same interception runs as a **PreToolUse hook** (`askQuestionHook`), which fires in every mode and short-circuits ahead of `canUseTool`. `hooksFor(mode)` composes it with the `/addon_configs` guard.
  - Because the answer arrives as `is_error: true`, both the live stream and `parseSession` correlate `tool_use` id → tool name and flag it `answered` so the UI renders it as an answer, not a failure (`isQuestionAnswer()`).
  - Pending questions live in a **module-level** `pendingDialogs` map, not per-connection, and **wait indefinitely** — a tab disconnecting (backgrounded app, phone asleep, closed browser) does *not* cancel one, however long it's been. A question belongs to the run, not to the socket that happened to be open when it was asked: any tab can answer it, and one that connects later — in ten minutes or tomorrow — is shown every entry still in `pendingDialogs` and can answer it then. The only things that end the wait are an actual answer, Skip, or the run itself ending (the tool call's own abort signal — Stop, a new prompt, a session switch). This used to auto-cancel on the last disconnect on the theory that nobody would come back; a phone backgrounding its browser drops the WebSocket routinely, so that read as the question silently vanishing while you were away. **Permission prompts don't get the same treatment** — `state.pendingPermissions` is still per-connection and is still denied immediately on that connection's `close` (and on the initial ask, if nobody's connected at all); fixing that would mean hoisting it to a module-level map with the same reconnect-replay plumbing as `pendingDialogs`, not yet done.
  - `onUserDialog` + `supportedDialogKinds` + `toolConfig` are still registered — the documented contract, harmless, and it feeds the same map should a future CLI build start using it. If it ever does, remove the by-hand path rather than leaving the two racing.
- **Questions and permission prompts can be set aside.** ✕ (or a backdrop tap) hides the card without answering; the request stays pending server-side and `#question-strip` above the composer is the way back. A dismissed question is not re-opened by the reconnect replay.
- **Context indicator** uses `query.getContextUsage()` (cache-inclusive `totalTokens` / `maxTokens` / `autoCompactThreshold` / `isAutoCompactEnabled`), broadcast as `context_usage` after each result and after compaction. The frontend shows tokens and **% toward auto-compaction**. The old input+output math undercounted because it ignored `cache_read_input_tokens`.
- **Compaction** is handled by the SDK (auto + `/compact`); the server forwards the `system`/`compact_boundary` event as `compacted` so the UI shows a divider and refreshes the indicator.

## Chat UI notes

- **Tool-call runs fold as they arrive**, not at the end of the turn — `refreshToolGroup()` runs on every call *and* every result, collapsing at ≥2 calls unless the user has opened the group (`_st.touched`, which a search hit also sets). The folded header carries the running call's name+argument, then the tool names and any failure count, so folding costs no information that was being watched.
- **Layout is a fixed frame with one scroller.** `html, body { overflow: hidden; overscroll-behavior: none }` and `#app { height: 100dvh }`; `.messages` adds `overscroll-behavior: contain`. Without these, on a *mobile browser* (not the HA app) a swipe past the end of the transcript chained to the Home Assistant page behind the ingress iframe and scrolled its header — and the app's own — out of reach.
- **`.chat-scroll` exists solely to anchor the ↑/↓ prompt arrows.** They can't be children of `.messages`: absolutely-positioned children of a scroll container scroll with its content.
- Prompt-arrow visibility is driven by real scroll gestures only — `markProgrammaticScroll()` fences off the app's own scrolling (streaming, jumps) so a streamed token can't flash them on.

## Key Files

| File | Purpose |
|------|---------|
| `config.yaml` | App manifest, options schema |
| `build.yaml` | Docker build args (base image) |
| `Dockerfile` | Image build: Node, Agent SDK binary, ha-ws-client, ha-lovelace/ha-history/ha-stats wrappers, plugin |
| `run.sh` | Entrypoint: env init, packages, HA context, start server |
| `server/index.js` | WebSocket server, Agent SDK integration, permission handling |
| `frontend/index.html` | Chat UI shell |
| `frontend/app.js` | WebSocket client, message rendering |
| `frontend/styles.css` | Dark theme styles |
| `plugins/homeassistant-config/PLUGIN.md` | Plugin manifest |
| `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md` | HA YAML patterns + tool docs |
