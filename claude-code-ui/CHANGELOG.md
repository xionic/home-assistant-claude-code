## 1.7.0
- **Fixed a host-crash risk from ESPHome builds:** ESPHome/PlatformIO write multi-GB, tens-of-thousands-of-files build caches under `/data`, which the nightly backup was tarring — the tiny-file IO storm starved the host watchdog and hard-reset the Pi. Those caches are now **excluded from backups** (`backup_exclude`), and compiles run at **idle CPU/IO priority** (`nice`/`ionice`) so a build can't starve the host. Caches still persist under `/data` for fast rebuilds
- **Copy button on code blocks and tool output** — hover (or tap on mobile) any code block or tool result to copy it
- **Auto-hiding header on mobile** — on small screens the top bar slides away as you scroll down a long chat and reappears the moment you scroll up, so you don't have to scroll to the very top to reach settings. On larger screens it stays pinned

## 1.6.0
- **ESPHome support** (new `enable_esphome` option, off by default): bundles the ESPHome CLI so Claude can validate, compile, OTA-flash, and stream device logs for boards you manage with the ESPHome add-on — working directly on that add-on's config folder. Ships as an opt-in capability module (its own skill + the `esphome` tool); the toolchain installs in the background on first enable, and compilers download on the first build
- The add-on now runs on a **Debian base** (was Alpine) — required so the ESPHome/PlatformIO compilers can run. No user-visible change beyond that

## 1.5.2
- Fixed: **Plan** can now be set as the default permission mode in the add-on options. It was offered in the app's dropdown but rejected by the options schema, so you could pick it per-chat but never default to it

## 1.5.1
- Entity links now open **inside** Home Assistant instead of bouncing you out to a web page — clicking an entity opens its usual more-info dialog (a switch gets its toggle, a thermostat its controls, a sensor its history), and automations/dashboards navigate the app without a page reload

## 1.5.0
- **"Always" on permission prompts** — Allow now only covers that one call; the new **Always** button makes the decision stick to the tool so it stops asking (uses the SDK's own suggested permission rules, shown on the prompt so you can see exactly what you're allowing)
- **Home Assistant deep links in replies** — entity ids Claude mentions become links: automations open their editor, other entities open their history. Links open the real HA page outside the add-on's frame, and only real entities are linked (YAML blocks are left alone)

## 1.4.0
- **Auto-continue on usage limit** (new Settings toggle): when you're signed in with a Claude subscription and hit the 5-hour usage limit mid-response, the add-on can automatically resume the conversation once the limit resets — no need to come back and nudge it. A banner shows the countdown (with a Cancel), the scheduled resume survives an add-on/HA restart, and it's off by default. Only offered on subscription sign-in (an API key has no reset time to schedule against); the 7-day limit is not auto-resumed.

## 1.3.1
- Chat no longer auto-scrolls to the bottom when you've scrolled up to read or copy something — incoming responses only pull the view down if you're already at the bottom (sending a prompt re-pins you there)

## 1.3.0
- **Plan mode** added to the permission dropdown — Claude researches read-only and proposes a plan before making changes; you approve the plan to proceed
- **Reasoning effort** selector in Settings (Low → Max) so you can trade speed for depth per chat
- **Message timestamps** — a compact time now appears on each message (live and after a reload)
- **Working indicator shows elapsed seconds** on long turns, so a quiet stretch (deep thinking, a slow tool, or compaction) reads as "still going" rather than stuck
- **Context warning** — the token indicator turns amber, then red with a "run /compact" nudge as the window fills
- **New-dashboard support** — `ha-lovelace create`/`delete` let Claude make and remove Lovelace dashboards (previously it could only edit existing ones)
- **/compact no longer clutters the chat** — the slash-command echo (`<command-name>…`) is filtered from the transcript
- **Add-on logging** — query start/end (with duration), compaction, errors, and a stall watchdog now log to the add-on log; a new **Verbose logging** option adds per-event detail for diagnosing hangs

## 1.2.0
- New **Allow access to other add-on configs** option (off by default): when enabled, Claude can read and edit other add-ons' config folders under `/addon_configs`; while disabled, any tool call touching that path is blocked at the tool layer (enforced in every permission mode, including Auto)

## 1.1.0
- AskUserQuestion no longer fails with a red X: the tool is disabled at the SDK level so Claude asks questions in conversational text instead
- Context indicator now shows real, cache-inclusive usage and **% toward auto-compaction** (from `query.getContextUsage()`) rather than an undercounted input+output figure
- Compaction is now visible — a "Context compacted" divider appears when `/compact` or auto-compaction runs, and the context indicator updates immediately
- CLAUDE.md is now user-editable and persistent: generated HA context moves to `~/.claude/ha-context.md` (refreshed each start) and is `@`-imported by a `~/.claude/CLAUDE.md` that the add-on seeds once and never overwrites

## 1.0.4
- Context token indicator above the input box shows how many tokens the next send will consume and what % of the model's context window that represents

## 1.0.3
- /usage now shows token counts (input, output, cache read/write, total) and explains what turns means

## 1.0.2
- Typed-but-not-submitted text is preserved when navigating away and back

## 1.0.1
- Markdown rendering in chat responses — tables, code blocks, headers, bold/italic, lists, and inline code now display correctly

## 1.0.0
- Multi-session support, find-in-chat, model/permission persistence, and UX improvements
