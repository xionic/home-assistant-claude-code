/*
 * The handful of values that genuinely span the whole process.
 *
 * They are gathered into one object rather than scattered as module-level `let`s
 * so that "what is mutable here, and who writes it" is answerable by reading one
 * file — and so a reader can tell shared state from a module's own bookkeeping.
 */
import { DEFAULT_PERMISSION_MODE } from './config.js';

export const runtime = {
  /** The SDK session being resumed. Persisted as a pointer in ACTIVE_FILE. */
  activeSessionId: null,

  /** AbortController for the in-flight query — global, not per-connection, so
   *  navigating away mid-response does not cancel the run. */
  activeQuery: null,

  /** Permission mode for the in-flight run, re-read on every canUseTool call so
   *  the user can change how tools are approved mid-prompt. */
  activePermMode: DEFAULT_PERMISSION_MODE,

  /** Plugin/agent slash commands from the SDK init event, cached so a newly
   *  connected client can populate its autocomplete immediately. */
  cachedSlashCommands: [],

  /** Set when a query fails for an auth reason. The credentials file still
   *  exists in that case, so isAuthenticated() alone would keep hiding the login
   *  screen; this is what lets the UI show a re-auth prompt instead. */
  credentialsExpired: false,

  /** Link targets so replies can turn entity ids into Home Assistant links. */
  haLinks: { entities: [], automations: {} },
};
