/*
 * Claude Code UI — Home Assistant app.
 *
 * A browser-based Claude Code interface: an Express + WebSocket server that
 * drives the Claude Agent SDK and streams the result to a chat UI, with direct
 * access to the Home Assistant configuration and live state.
 *
 * This file is the composition root and nothing else — it wires the modules in
 * server/lib together, loads the persisted state, and listens. Anything with
 * behaviour of its own lives in a module; if you are looking for something:
 *
 *   config.js         every environment variable and derived path
 *   state.js          the mutable values that span the whole process
 *   broadcast.js      connected sockets, send() and broadcast()
 *   auth.js           credentials and the device-login flow
 *   sessions.js       Claude Code's on-disk transcript store
 *   dialogs.js        AskUserQuestion interception
 *   permissions.js    the /addon_configs guard and canUseTool
 *   auto-continue.js  resuming after a usage limit resets
 *   run-query.js      one turn: SDK options in, wire events out
 *   ws-protocol.js    what a browser is told, and what it may ask for
 *   diag.js           the /diag routes (debug option only)
 *   uploads.js        attachments
 *   ha-links.js       entity/automation link targets
 *   mcp.js            stripping persisted MCP servers at startup
 */
import { createServer } from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';

import {
  PORT, WORK_DIR, PLUGIN_DIR, FRONTEND_DIR, UPLOAD_DIR, DEBUG_MODE,
  ALLOW_ADDON_CONFIGS, ENABLE_ESPHOME, ESPHOME_CONFIG_DIR, VERBOSE_LOGGING,
} from './lib/config.js';
import { isSubscriptionAuth } from './lib/auth.js';
import { loadActive } from './lib/sessions.js';
import { sanitizeMcpState } from './lib/mcp.js';
import { ensureUploadDir, cleanupUploads } from './lib/uploads.js';
import { refreshHaLinks } from './lib/ha-links.js';
import { registerDiagRoutes } from './lib/diag.js';
import { attach } from './lib/ws-protocol.js';
import { runQuery } from './lib/run-query.js';
import * as autoContinue from './lib/auto-continue.js';

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(FRONTEND_DIR));

ensureUploadDir();
app.use('/uploads', express.static(UPLOAD_DIR));

// Only when the `debug` app option is on. Otherwise these routes do not exist
// and the requests fall through to the SPA below.
if (DEBUG_MODE) registerDiagRoutes(app);

// Single-page app: every other path serves the shell, so ingress deep links work.
app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

attach(wss);

// ── Startup ──────────────────────────────────────────────────────────────────
// run-query imports auto-continue (to schedule a resume when a limit stops a
// run); auto-continue needs to call back into run-query when that resume fires.
// Injecting it here keeps the module graph one-way.
autoContinue.setResumeRunner(runQuery);

sanitizeMcpState();
loadActive();
autoContinue.load();
cleanupUploads();          // drop attachments older than a week
refreshHaLinks();          // populate entity/automation link targets
autoContinue.rearmOnBoot();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code UI listening on port ${PORT}`);
  console.log(`  Working dir: ${WORK_DIR}`);
  console.log(`  Plugin dir:  ${PLUGIN_DIR}`);
  console.log(`  /addon_configs access: ${ALLOW_ADDON_CONFIGS ? 'enabled' : 'blocked'}`);
  console.log(`  ESPHome capability: ${ENABLE_ESPHOME ? `on (${ESPHOME_CONFIG_DIR || 'no config dir'})` : 'off'}`);
  console.log(`  Auto-continue on limit: ${autoContinue.autoContinue.enabled ? 'on' : 'off'} ` +
    `(${isSubscriptionAuth() ? 'subscription' : 'api-key'} auth)`);
  console.log(`  Verbose logging: ${VERBOSE_LOGGING ? 'on' : 'off'}`);
});
