/*
 * Everything the app reads from its environment, in one place.
 *
 * The defaults are the container layout: Home Assistant sets none of these, so
 * in production every value below is the fallback. They are overridable so the
 * server can be booted against a scratch directory under test.
 */
import path from 'path';

export const PORT = parseInt(process.env.SERVER_PORT || '7681', 10);
export const WORK_DIR = process.env.WORK_DIR || '/config';
export const PLUGIN_DIR = process.env.PLUGIN_DIR || '/opt/plugins/homeassistant-config';
export const CLAUDE_CONFIG_DIR = process.env.ANTHROPIC_CONFIG_DIR || '/data/.config/claude';
export const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
export const DEFAULT_PERMISSION_MODE = process.env.DEFAULT_PERMISSION_MODE || 'ask';
export const VERBOSE_LOGGING = process.env.VERBOSE_LOGGING === 'true';

/** The app's persistent volume, its static assets, and the agent's own home. */
export const DATA_DIR = process.env.DATA_DIR || '/data';
export const FRONTEND_DIR = process.env.FRONTEND_DIR || '/opt/frontend';
export const HOME_DIR = process.env.HOME || '/data/home';

/** Supervisor base URL — the same override scripts/lib/ha-rest.cjs uses. */
export const SUPERVISOR_URL = process.env.HA_SUPERVISOR_URL || 'http://supervisor';

// Optional ESPHome capability. When enabled we load an extra local plugin (the
// esphome skill) and exempt the ESPHome app's config folder from the
// addon-configs guard so the esphome CLI can work on it.
export const ENABLE_ESPHOME = process.env.ENABLE_ESPHOME === 'true';
export const ESPHOME_CONFIG_DIR = process.env.ESPHOME_CONFIG_DIR || '';
export const ESPHOME_PLUGIN_DIR = '/opt/plugins/esphome';

/** Plugins loaded for every query (the HA-config plugin always; esphome opt-in). */
export const PLUGINS = [{ type: 'local', path: PLUGIN_DIR }];
if (ENABLE_ESPHOME) PLUGINS.push({ type: 'local', path: ESPHOME_PLUGIN_DIR });

// Whether the agent may touch other apps' config folders. HA always mounts
// `all_app_configs` at /addon_configs (folder maps are static), so this flag
// — set from the `allow_addon_configs` app option — is what actually gates
// access, enforced by the PreToolUse hook in permissions.js.
export const ALLOW_ADDON_CONFIGS = process.env.ALLOW_ADDON_CONFIGS === 'true';
export const ADDON_CONFIGS_PATH = '/addon_configs';

/** Tools auto-approved in 'acceptEdits' mode (file edits only). */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Valid reasoning-effort levels the UI can request (SDK `effort` option). */
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Files the app owns on its persistent volume. */
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const ACTIVE_FILE = path.join(DATA_DIR, 'active-session.json');
export const AUTO_CONTINUE_FILE = path.join(DATA_DIR, 'auto-continue.json');

/**
 * Claude Code's canonical transcript store, keyed on the project directory —
 * the same store the CLI uses, which is what makes sessions interchangeable.
 */
export const STORE_DIR = path.join(HOME_DIR, '.claude', 'projects', WORK_DIR.replace(/\//g, '-'));

// ── Auto-continue on usage-limit reset (subscription auth only) ───────────────
export const AUTO_CONTINUE_BUFFER_MS = 15000;    // resume a little past resetsAt, to be safe
export const AUTO_CONTINUE_MAX_ATTEMPTS = 3;     // consecutive resumes before giving up
export const AUTO_CONTINUE_PROMPT =
  'The usage limit has reset. Please continue from where you left off.';

// An offer is only worth showing while it still means something. The grace
// window keeps it on screen for a while after the reset, so "you can send again
// now" is still visible when you next look.
export const LIMIT_OFFER_GRACE_MS = 30 * 60 * 1000;
