/*
 * How a tool call gets approved: the /addon_configs guard, and the canUseTool
 * that backs the ask / acceptEdits / bypass / plan modes.
 *
 * Two mechanisms, deliberately. A PreToolUse *hook* is used for the
 * /addon_configs guard because it runs in **all** permission modes — including
 * `auto`, which has no canUseTool at all — and its deny short-circuits the tool
 * before it executes. canUseTool is used for anything the user should be asked
 * about, because only it can carry a decision back from the browser.
 */
import { randomUUID } from 'crypto';
import {
  ALLOW_ADDON_CONFIGS, ADDON_CONFIGS_PATH, ENABLE_ESPHOME, ESPHOME_CONFIG_DIR, EDIT_TOOLS,
} from './config.js';
import { log } from './log.js';
import { runtime } from './state.js';
import { connections, send, broadcast } from './broadcast.js';
import { askQuestion, formatQuestionDenial, askQuestionHook } from './dialogs.js';

/**
 * Render the SDK's suggested permission rules into a short human label for the
 * "Always" button (e.g. "Bash(git status:*)" or "Read").
 */
export function describeSuggestions(suggestions) {
  const rules = [];
  for (const s of suggestions || []) {
    if ((s.type === 'addRules' || s.type === 'replaceRules') && Array.isArray(s.rules)) {
      for (const r of s.rules) rules.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    } else if (s.type === 'setMode') {
      rules.push(`mode: ${s.mode}`);
    }
  }
  return [...new Set(rules)].join(', ');
}

/**
 * When ESPHome is enabled, its config folder under /addon_configs is a
 * legitimate target even if broad access is off — but only that folder. A tool
 * call qualifies when *every* /addon_configs reference in it is inside that dir.
 */
export function touchesOnlyEsphome(blob) {
  if (!ENABLE_ESPHOME || !ESPHOME_CONFIG_DIR) return false;
  const refs = blob.match(/\/addon_configs\/[^"'\s)]+/g) || [];
  return refs.length > 0 && refs.every((r) => r === ESPHOME_CONFIG_DIR || r.startsWith(ESPHOME_CONFIG_DIR + '/'));
}

/**
 * Matching the absolute path in the serialized tool input catches Read/Edit/Write
 * (file_path), Glob/Grep (path) and Bash (command) uniformly; nothing under
 * /addon_configs is reachable from the /config cwd without naming that path.
 */
export function addonConfigsDenyHook(input) {
  const blob = JSON.stringify(input?.tool_input ?? '');
  if (!blob.includes(ADDON_CONFIGS_PATH)) return { continue: true };
  if (touchesOnlyEsphome(blob)) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Access to /addon_configs (other apps’ configuration) is disabled. ' +
        'Turn on "Allow access to other app configs" in the app Configuration tab to enable it.',
    },
  };
}

// Registered only when access is disabled: with it enabled there is no guard to
// run, so this avoids a per-tool-call round trip to the subprocess.
const ADDON_CONFIGS_HOOK = ALLOW_ADDON_CONFIGS ? null : async (input) => addonConfigsDenyHook(input);

export const ADDON_CONFIGS_HOOKS = ADDON_CONFIGS_HOOK
  ? { PreToolUse: [{ hooks: [ADDON_CONFIGS_HOOK] }] }
  : undefined;

/** PreToolUse hooks for a run: the guard, plus the question interceptor in `auto`. */
export function hooksFor(mode) {
  const pre = [];
  if (ADDON_CONFIGS_HOOK) pre.push(ADDON_CONFIGS_HOOK);
  if (mode === 'auto') pre.push(askQuestionHook);
  return pre.length ? { PreToolUse: [{ hooks: pre }] } : undefined;
}

/**
 * Shared permission state for headless auto-continue runs. A tool prompt during
 * an auto-resume has no originating browser socket, so it is surfaced to — and
 * answered by — any connected client through this module-level state rather than
 * hanging on a socket that was never open.
 */
export const autoResumeState = { pendingPermissions: new Map() };

/**
 * Resolve a prompt the user answered. The prompt may belong to this client's run
 * or to a headless resume, which any tab may answer.
 */
export function resolvePermission(state, id, decision) {
  const entry = state.pendingPermissions.get(id) || autoResumeState.pendingPermissions.get(id);
  if (!entry) return false;
  state.pendingPermissions.delete(id);
  autoResumeState.pendingPermissions.delete(id);
  entry.resolve(decision);
  return true;
}

/**
 * Switching to a more permissive mode mid-prompt should not leave a card on
 * screen that the new mode would now allow — across every tab, and including a
 * headless resume's prompt.
 */
export function resolvePromptsAllowedBy(mode) {
  if (mode !== 'bypass' && mode !== 'acceptEdits') return;
  const permits = (toolName) => mode === 'bypass' || EDIT_TOOLS.has(toolName);

  for (const conn of connections) {
    const pending = conn._state?.pendingPermissions;
    if (!pending) continue;
    for (const [id, entry] of pending) {
      if (!permits(entry.toolName)) continue;
      pending.delete(id);
      entry.resolve('allow');
      send(conn, { type: 'permission_resolved', id });
    }
  }
  for (const [id, entry] of autoResumeState.pendingPermissions) {
    if (!permits(entry.toolName)) continue;
    autoResumeState.pendingPermissions.delete(id);
    entry.resolve('allow');
    broadcast({ type: 'permission_resolved', id });
  }
}

/**
 * Build the canUseTool for one run.
 *
 * It reads `runtime.activePermMode` at call time rather than closing over the
 * mode it was built with, which is what makes switching modes mid-prompt take
 * effect immediately.
 */
export function makeCanUseTool(ws, state) {
  return (toolName, input, options) => {
    // A question is Claude asking the human something, not an action needing
    // approval — it never reaches the permission modes below.
    if (toolName === 'AskUserQuestion') {
      return askQuestion(input, options.signal).then((answer) => formatQuestionDenial(input, answer));
    }

    const mode = runtime.activePermMode;
    if (mode === 'bypass' || (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    // Plan mode: the SDK restricts the model to read-only tools, so allow those
    // silently and only prompt when it proposes leaving plan mode.
    if (mode === 'plan' && toolName !== 'ExitPlanMode') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }

    return new Promise((resolve) => {
      const id = randomUUID();
      // The SDK hands us `suggestions`: permission rules that would stop it
      // asking again for this kind of call (e.g. Bash(git status:*)). Handing
      // them straight back as `updatedPermissions` on an allow is what makes a
      // decision stick to the *tool* rather than to this one call.
      const suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];
      const req = {
        type: 'permission_request',
        id,
        toolName,
        input,
        title: options.title,
        description: options.description,
        canAlways: suggestions.length > 0,
        alwaysLabel: describeSuggestions(suggestions),
      };

      if (ws.readyState === 1) {
        send(ws, req);
      } else if (connections.size > 0) {
        // Headless run (e.g. auto-continue): no originating socket, so ask
        // whichever tabs are connected.
        broadcast(req);
      } else {
        log('INFO', `permission needed for ${toolName} but no client is connected — denying`);
        resolve({ behavior: 'deny', message: 'No interactive client connected to approve this tool.' });
        return;
      }

      // 'allow' (this call) | 'always' (this call + persist the rule) | 'deny'
      const finish = (decision) => {
        if (decision === 'always' && suggestions.length) {
          log('INFO', `permission: always-allow ${describeSuggestions(suggestions)}`);
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: suggestions });
        } else if (decision === 'always' || decision === 'allow') {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          resolve({ behavior: 'deny', message: 'Denied by user' });
        }
      };

      state.pendingPermissions.set(id, { toolName, resolve: finish });
      options.signal.addEventListener('abort', () => {
        state.pendingPermissions.delete(id);
        resolve({ behavior: 'deny', message: 'Aborted' });
      }, { once: true });
    });
  };
}
