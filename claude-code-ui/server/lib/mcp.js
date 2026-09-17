/*
 * MCP state hygiene.
 *
 * The Claude Code CLI persists MCP servers into ~/.claude.json (globally and
 * per-project), and the SDK auto-loads them on every run. An early MCP-enabled
 * build of this app wrote a `home-assistant` server under projects["/config"],
 * which then kept loading and failing long after we stopped configuring one.
 *
 * ha-mcp has since been removed entirely (ha-ws-client / ha-tools do the job),
 * so any persisted definition is stripped at startup. **Do not delete this**
 * even though we no longer configure MCP servers ourselves — the point is the
 * ones we did not configure.
 *
 * .claude.json is not the only way one arrives, though — see MCP_FREE_SETTINGS.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { HOME_DIR } from './config.js';

/**
 * Settings passed to every run to keep the session MCP-free.
 *
 * From Agent SDK 0.3.26x the CLI auto-fetches the *account's* claude.ai cloud
 * connectors (Gmail, Drive, Calendar …) and connects them — they come from the
 * logged-in claude.ai account, not from any file on disk, so sanitizeMcpState()
 * cannot see them and the live suite caught three loading after the bump.
 *
 * That matters here beyond noise: the SDK does not invoke `canUseTool` for MCP
 * tools, so a connector's tools would run without ever raising a permission
 * prompt — silently outside the permission mode the user picked, and reaching
 * their mailbox rather than their house. `disableClaudeAiConnectors` is
 * any-source-true, and an inline `settings` object is the highest-priority
 * user-controlled source, so this holds regardless of what is on disk.
 */
export const MCP_FREE_SETTINGS = { disableClaudeAiConnectors: true };

export function sanitizeMcpState() {
  const file = path.join(HOME_DIR, '.claude.json');
  if (!existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    let changed = false;
    if (data.mcpServers && Object.keys(data.mcpServers).length) { data.mcpServers = {}; changed = true; }
    if (data.projects && typeof data.projects === 'object') {
      for (const proj of Object.values(data.projects)) {
        if (proj && proj.mcpServers && Object.keys(proj.mcpServers).length) { proj.mcpServers = {}; changed = true; }
      }
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(data, null, 2));
      console.log('Sanitized persisted mcpServers from .claude.json (MCP is managed via opts only)');
    }
  } catch (e) {
    console.warn('Could not sanitize .claude.json:', e.message);
  }
}
