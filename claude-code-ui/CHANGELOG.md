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
