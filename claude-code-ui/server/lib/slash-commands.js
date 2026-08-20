/*
 * Which of Claude Code's slash commands make sense here.
 *
 * The CLI advertises every command it supports, including ones whose whole
 * behaviour is bound to a local terminal — `/exit`, `/statusline`, and the like.
 * They are meaningless in a browser: there is no terminal to exit, and offering
 * them in the autocomplete is an invitation to a command that silently does
 * nothing.
 *
 * The SDK tags them for exactly this reason. Its `terminal_slash_commands` is a
 * subset of `slash_commands`, documented as "Phone/remote UIs should hide these
 * from command menus; desktop surfaces may keep them" — and this app is squarely
 * the former. The field is absent on older CLIs and on sessions where nothing is
 * tagged, so its absence has to mean "keep everything", not "hide everything".
 */

/**
 * The commands a browser should be offered, from an SDK `system/init` event.
 * Returns null when the event carries no command list at all, so a caller can
 * tell "none advertised" from "advertised, and all of them filtered out".
 */
export function usableSlashCommands(event) {
  if (!Array.isArray(event?.slash_commands)) return null;
  const terminalOnly = new Set(
    Array.isArray(event.terminal_slash_commands) ? event.terminal_slash_commands : []);
  if (!terminalOnly.size) return event.slash_commands;
  return event.slash_commands.filter((c) => !terminalOnly.has(c));
}
