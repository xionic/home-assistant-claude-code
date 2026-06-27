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
