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
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { HOME_DIR } from './config.js';

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
