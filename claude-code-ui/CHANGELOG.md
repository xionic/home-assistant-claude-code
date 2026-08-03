## 1.9.3
- Model picker updated to the current Claude models: **Opus 5** and **Sonnet 5** replace Opus 4.8 and Sonnet 4.6 (Haiku 4.5 is unchanged). If you'd already picked an older model it keeps working and still shows by name — switch in **Settings → Model** to move up
- The Home Assistant suggestions subagent now runs on Sonnet 5

## 1.9.2
- Wording brought in line with Home Assistant's current terminology — add-ons are **apps**, and the install steps in the README now match the real path (**Settings → Apps → Install app → ⋮ → Repositories**). Thanks to Sir_Goodenough on the community forum for flagging it
- Folder mappings updated to Home Assistant's current names (`homeassistant_config` and `all_app_configs`), replacing the deprecated `config` / `all_addon_configs`. Nothing moves inside the app — Home Assistant's config stays at `/config` and other apps' configs at `/addon_configs`. **Now requires Supervisor 2026.07 or newer**
- Fixed the chat jumping to the bottom while you were reading it — a background reconnect replayed the whole conversation, which lost your scroll position and dragged the view down
- Removed the scroll-to-bottom animation when the chat loads; it now opens at the bottom instantly instead of visibly racing down from the top

## 1.9.1
- Composer redesigned so the attach and send buttons sit on their own row below the text — the typing area now spans the full width, like the Claude app
- Fixed attaching **multiple** photos silently failing on mobile (files the picker reported as zero-size were being dropped)
- Attached images are now downscaled before sending, so photos upload far faster and many fit at once (also normalizes formats like HEIC)

## 1.9.0
- **Attach images, photos, and files** to a message — via the paperclip button, pasting a screenshot, or drag-and-drop. Claude reads them (it sees images/PDFs and reads text/code). On mobile the picker offers the camera and photo library

## 1.8.3
- Fixed: after re-authenticating in a long chat, typing "continue" started a new empty session instead of resuming — an auth failure no longer discards the current session

## 1.8.2
- Fixed the sign-in code box vanishing when you switch to the browser and back during (re-)authentication — an in-progress login is now restored on reconnect, and login success is detected only when fresh credentials are written

## 1.8.1
- When your Claude sign-in expires, the chat now shows a "Session expired" screen with a Sign-in button to re-authenticate, instead of just failing with an error

## 1.8.0
- ESPHome build dependencies (patch, compilers, etc.) now install automatically when ESPHome is enabled and reinstall after app upgrades, so compiles keep working without manual apt installs

## 1.7.2
- Fixed the mobile header jittering up and down when scrolling near the bottom of a long chat

## 1.7.1
- App option descriptions trimmed to one or two sentences

## 1.7.0
- **Fixed a host-crash risk from ESPHome builds:** ESPHome/PlatformIO write multi-GB, tens-of-thousands-of-files build caches under `/data`, which the nightly backup was tarring — the tiny-file IO storm starved the host watchdog and hard-reset the Pi. Those caches are now **excluded from backups** (`backup_exclude`), and compiles run at **idle CPU/IO priority** (`nice`/`ionice`) so a build can't starve the host. Caches still persist under `/data` for fast rebuilds
- **Copy button on code blocks and tool output** — hover (or tap on mobile) any code block or tool result to copy it
- **Auto-hiding header on mobile** — on small screens the top bar slides away as you scroll down a long chat and reappears the moment you scroll up, so you don't have to scroll to the very top to reach settings. On larger screens it stays pinned

## 1.6.0
- **ESPHome support** (new `enable_esphome` option, off by default): bundles the ESPHome CLI so Claude can validate, compile, OTA-flash, and stream device logs for boards you manage with the ESPHome app — working directly on that app's config folder. Ships as an opt-in capability module (its own skill + the `esphome` tool); the toolchain installs in the background on first enable, and compilers download on the first build
- The app now runs on a **Debian base** (was Alpine) — required so the ESPHome/PlatformIO compilers can run. No user-visible change beyond that

## 1.5.2
- Fixed: **Plan** can now be set as the default permission mode in the app options. It was offered in the app's dropdown but rejected by the options schema, so you could pick it per-chat but never default to it

## 1.5.1
- Entity links now open **inside** Home Assistant instead of bouncing you out to a web page — clicking an entity opens its usual more-info dialog (a switch gets its toggle, a thermostat its controls, a sensor its history), and automations/dashboards navigate the app without a page reload

## 1.5.0
- **"Always" on permission prompts** — Allow now only covers that one call; the new **Always** button makes the decision stick to the tool so it stops asking (uses the SDK's own suggested permission rules, shown on the prompt so you can see exactly what you're allowing)
- **Home Assistant deep links in replies** — entity ids Claude mentions become links: automations open their editor, other entities open their history. Links open the real HA page outside the app's frame, and only real entities are linked (YAML blocks are left alone)

## 1.4.0
- **Auto-continue on usage limit** (new Settings toggle): when you're signed in with a Claude subscription and hit the 5-hour usage limit mid-response, the app can automatically resume the conversation once the limit resets — no need to come back and nudge it. A banner shows the countdown (with a Cancel), the scheduled resume survives an app/HA restart, and it's off by default. Only offered on subscription sign-in (an API key has no reset time to schedule against); the 7-day limit is not auto-resumed.

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
- **App logging** — query start/end (with duration), compaction, errors, and a stall watchdog now log to the app log; a new **Verbose logging** option adds per-event detail for diagnosing hangs

## 1.2.0
- New **Allow access to other app configs** option (off by default): when enabled, Claude can read and edit other apps' config folders under `/addon_configs`; while disabled, any tool call touching that path is blocked at the tool layer (enforced in every permission mode, including Auto)

## 1.1.0
- AskUserQuestion no longer fails with a red X: the tool is disabled at the SDK level so Claude asks questions in conversational text instead
- Context indicator now shows real, cache-inclusive usage and **% toward auto-compaction** (from `query.getContextUsage()`) rather than an undercounted input+output figure
- Compaction is now visible — a "Context compacted" divider appears when `/compact` or auto-compaction runs, and the context indicator updates immediately
- CLAUDE.md is now user-editable and persistent: generated HA context moves to `~/.claude/ha-context.md` (refreshed each start) and is `@`-imported by a `~/.claude/CLAUDE.md` that the app seeds once and never overwrites

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
