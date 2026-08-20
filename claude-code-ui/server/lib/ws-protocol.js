/*
 * The WebSocket protocol: what a connecting browser is told, and what it may
 * ask for.
 *
 * The inbound half is a dispatch table rather than a chain of `else if`s, so the
 * set of messages the client may send is a list you can read.
 */
import { DEFAULT_PERMISSION_MODE } from './config.js';
import { log } from './log.js';
import { runtime } from './state.js';
import { connections, send, broadcast } from './broadcast.js';
import {
  isAuthenticated, isSubscriptionAuth, startLoginFlow, loginUrl, loginProcess,
} from './auth.js';
import { listSessions, parseSession, deleteSession, saveActive } from './sessions.js';
import { pendingDialogs, answerDialog } from './dialogs.js';
import { resolvePermission, resolvePromptsAllowedBy } from './permissions.js';
import { saveAttachments, describeAttachments } from './uploads.js';
import { runQuery, abortActive } from './run-query.js';
import * as autoContinue from './auto-continue.js';

/** Everything a newly connected (or reconnected) tab needs to render the app. */
function greet(ws) {
  send(ws, { type: 'connected' });
  send(ws, {
    type: 'config',
    defaultPermMode: DEFAULT_PERMISSION_MODE,
    autoContinue: autoContinue.autoContinue.enabled,
    autoContinueSupported: isSubscriptionAuth(),
  });
  send(ws, { type: 'auth_status', authenticated: isAuthenticated() && !runtime.credentialsExpired });
  if (runtime.credentialsExpired) send(ws, { type: 'auth_expired', subscription: isSubscriptionAuth() });
  // A login is mid-flight (reconnected while waiting to paste the code) — restore
  // the URL and code box, so switching to the browser and back does not lose it.
  const url = loginUrl();
  if (url) send(ws, { type: 'auth_url', url });
  send(ws, { type: 'slash_commands', commands: runtime.cachedSlashCommands });
  send(ws, { type: 'ha_links', entities: runtime.haLinks.entities, automations: runtime.haLinks.automations });
  send(ws, { type: 'sessions', sessions: listSessions(), activeId: runtime.activeSessionId });
  send(ws, { type: 'history', items: parseSession(runtime.activeSessionId), running: !!runtime.activeQuery });

  // Replay a scheduled resume so a reconnecting tab shows the countdown, or —
  // when nothing is scheduled — the standing offer to turn one on.
  const pending = autoContinue.autoContinue.pending;
  const offer = autoContinue.liveLimitOffer();
  if (pending) {
    send(ws, { type: 'auto_continue_pending', resetsAt: pending.resetsAt,
      rateLimitType: pending.rateLimitType, attempts: pending.attempts });
  } else if (offer) {
    send(ws, { type: 'limit_offer', resetsAt: offer.resetsAt,
      rateLimitType: offer.rateLimitType, supported: isSubscriptionAuth() });
  }

  // A question Claude asked while this tab was away belongs to the run, not to
  // the socket that happened to be open — so it is still waiting, and this is
  // what shows it rather than leaving the turn silently paused.
  for (const [id, d] of pendingDialogs) {
    send(ws, { type: 'user_dialog', id, dialogKind: 'askUserQuestion', payload: d.payload });
  }
}

function broadcastSessions() {
  broadcast({ type: 'sessions', sessions: listSessions(), activeId: runtime.activeSessionId });
}

/** Everything the browser may send. One entry per message type. */
const handlers = {
  auth_check(ws) {
    send(ws, { type: 'auth_status', authenticated: isAuthenticated() });
  },

  auth_login() {
    startLoginFlow(broadcast, () => { runtime.credentialsExpired = false; });
  },

  auth_code(_ws, msg) {
    const proc = loginProcess();
    if (proc && proc.stdin) proc.stdin.write(msg.code + '\n');
  },

  prompt(ws, msg, state) {
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      msg.text = describeAttachments(msg.text, saveAttachments(msg.attachments));
    }
    delete msg.attachments;   // do not carry the base64 payload any further
    runQuery(ws, state, msg);
  },

  abort() {
    abortActive();
  },

  new_session() {
    abortActive();
    autoContinue.cancel('new-session');
    autoContinue.clearLimitOffer('new-session');
    runtime.activeSessionId = null;
    saveActive();
    broadcast({ type: 'cleared' });
    broadcastSessions();
  },

  sessions_list(ws) {
    send(ws, { type: 'sessions', sessions: listSessions(), activeId: runtime.activeSessionId });
  },

  session_switch(_ws, msg) {
    abortActive();
    autoContinue.cancel('session-switch');
    autoContinue.clearLimitOffer('session-switch');
    runtime.activeSessionId = msg.id || null;
    saveActive();
    broadcast({ type: 'history', items: parseSession(runtime.activeSessionId), running: false });
    broadcastSessions();
  },

  session_delete(_ws, msg) {
    deleteSession(msg.id);
    if (msg.id === runtime.activeSessionId) {
      runtime.activeSessionId = null;
      saveActive();
      broadcast({ type: 'cleared' });
    }
    broadcastSessions();
  },

  permission_response(_ws, msg, state) {
    // 'allow' | 'always' | 'deny' — 'always' also persists the SDK's suggested
    // rule so this tool stops prompting.
    resolvePermission(state, msg.id, msg.decision);
  },

  user_dialog_response(_ws, msg) {
    // An answer to an AskUserQuestion. `result` absent means Skip — Claude is
    // told nobody answered and carries on. (Closing the card to read the chat
    // first sends nothing at all: the question stays pending, and the strip above
    // the composer is the way back to it.)
    answerDialog(msg.id, msg.result);
  },

  set_perm_mode(_ws, msg) {
    // Takes effect immediately for ask/acceptEdits/bypass, which route through
    // canUseTool. A run started in 'auto' keeps the SDK classifier for its
    // duration.
    runtime.activePermMode = msg.mode;
    resolvePromptsAllowedBy(msg.mode);
  },

  set_auto_continue(_ws, msg) {
    autoContinue.setEnabled(msg.enabled);
  },

  cancel_auto_continue() {
    autoContinue.cancel('user');
  },
};

export function attach(wss) {
  wss.on('connection', (ws) => {
    connections.add(ws);

    const state = { pendingPermissions: new Map() };
    ws._state = state;   // exposed so set_perm_mode can resolve prompts across tabs

    greet(ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const handler = handlers[msg.type];
      if (!handler) return;
      try {
        handler(ws, msg, state);
      } catch (e) {
        log('ERROR', `handling ${msg.type} failed: ${e?.message || e}`);
      }
    });

    ws.on('close', () => {
      connections.delete(ws);
      // The active query is deliberately NOT aborted: it keeps running and
      // persisting, so the chat is complete when the user navigates back. Only
      // this client's pending permission prompts are cleared, so the run does not
      // hang waiting on a browser that has gone.
      for (const entry of state.pendingPermissions.values()) entry.resolve('deny');
      state.pendingPermissions.clear();
      // Questions are NOT cleared here. They are not tied to a connection — a
      // phone backgrounding its browser drops the socket routinely, and that used
      // to auto-answer the question "closed without answering" behind the user's
      // back. The run itself owns the wait (via the tool call's abort signal), so
      // Stop, a new prompt, or a session switch already end it correctly.
    });
  });
}
