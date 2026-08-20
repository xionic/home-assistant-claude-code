/*
 * The WebSocket: connecting, reconnecting, authentication, and the dispatch of
 * every message the server sends.
 */
import { S } from './state.js';
import { appendLimitNotice, hideAcBanner, showAcBanner } from './banners.js';
import { clearScreen } from './commands.js';
import { setStatus, updateSendBtn } from './composer.js';
import { closePermission, dropDialog, pendingPerm, showPermissionPrompt, showUserDialog } from './dialogs.js';
import { autoContinueToggle, loginBtn, loginCodeForm, loginCodeInput, loginDesc, loginScreen, loginTitle, loginUrlEl, loginUrlSect, loginWaiting, modelSelect, permModeSelect, sessionsPanel, wsUrl } from './dom.js';
import { relinkRenderedBubbles } from './links.js';
import { ensureModelOption, updateCtxHint } from './model.js';
import { renderSessions } from './sessions.js';
import { setAutoContinueSupported } from './settings.js';
import { hideThinking, showThinking } from './thinking.js';
import { appendAssistantText, appendCompactedDivider, appendErrorBubble, appendInfoLine, appendResultLine, appendToolResult, appendToolUse, appendUserBubble, endToolGroup, renderHistory } from './transcript.js';

// ── WebSocket ─────────────────────────────────────────────────────────────

export function connect() {
  S.ws = new WebSocket(wsUrl);

  S.ws.onopen    = () => { S.isConnected = true;  setStatus('connected'); };
  S.ws.onclose   = () => { S.isConnected = false; S.isRunning = false; setStatus('disconnected'); updateSendBtn(); setTimeout(connect, 3000); };
  S.ws.onerror   = () => S.ws.close();
  S.ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
}

export function setAuthenticated(authenticated) {
  if (authenticated) {
    loginScreen.classList.add('hidden');
  } else {
    loginScreen.classList.remove('hidden');
    // Default (first-time / signed-out) copy; showReauth() overrides for expiry.
    loginTitle.textContent = 'Connect to Anthropic';
    loginDesc.textContent = 'Sign in to your Anthropic account to use Claude.';
    loginBtn.classList.remove('hidden');
    loginUrlSect.classList.add('hidden');
    loginCodeForm.classList.add('hidden');
    loginWaiting.classList.add('hidden');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in with Anthropic';
  }
}

// Credentials expired (or were rejected) mid-use — surface the login screen with
// a re-auth message so there's a clear button to sign in again.
export function showReauth(subscription) {
  setAuthenticated(false);
  if (subscription === false) {
    // API-key auth: a device-flow login won't help, so point at the option.
    loginTitle.textContent = 'Authentication failed';
    loginDesc.textContent = 'Your Anthropic API key was rejected — check it in the app options.';
    loginBtn.classList.add('hidden');
  } else {
    loginTitle.textContent = 'Session expired';
    loginDesc.textContent = 'Your Claude sign-in has expired. Sign in again to continue.';
  }
}

loginBtn.onclick = () => {
  loginBtn.disabled = true;
  loginBtn.textContent = 'Opening…';
  S.ws.send(JSON.stringify({ type: 'auth_login' }));
};

loginCodeForm.onsubmit = (e) => {
  e.preventDefault();
  const code = loginCodeInput.value.trim();
  if (!code) return;
  S.ws.send(JSON.stringify({ type: 'auth_code', code }));
  loginCodeForm.classList.add('hidden');
  loginWaiting.classList.remove('hidden');
};

export function handleServerMessage(msg) {
  switch (msg.type) {
    case 'connected': break;
    case 'session':   break;

    case 'config':
      // Server-provided default permission mode for new chats. The user's own
      // saved choice (localStorage) always wins.
      if (!localStorage.getItem('permMode') && msg.defaultPermMode) {
        permModeSelect.value = msg.defaultPermMode;
      }
      // Auto-continue state is server-owned (persisted in /data), so the server
      // is the source of truth — just reflect it.
      if (msg.autoContinue != null) autoContinueToggle.checked = !!msg.autoContinue;
      setAutoContinueSupported(msg.autoContinueSupported !== false);
      break;

    case 'auth_status':
      setAuthenticated(msg.authenticated);
      break;

    case 'auth_expired':
      showReauth(msg.subscription);
      break;

    case 'slash_commands':
      S.pluginCommands = Array.isArray(msg.commands) ? msg.commands : [];
      break;

    case 'ha_links': {
      // Entity/automation link targets. These usually land just after the
      // history replay, so re-render already-rendered bubbles to pick up links.
      const had = S.haEntities.size;
      S.haEntities = new Set(Array.isArray(msg.entities) ? msg.entities : []);
      S.haAutomationIds = msg.automations || {};
      if (!had && S.haEntities.size) relinkRenderedBubbles();
      break;
    }

    case 'model':
      // The model actually in use, reported by the SDK init event
      if (msg.model) {
        ensureModelOption(msg.model);
        if (!localStorage.getItem('model')) modelSelect.value = msg.model;
      }
      break;

    case 'sessions':
      S.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      S.activeSessionId = msg.activeId || null;
      if (!sessionsPanel.classList.contains('hidden')) renderSessions();
      break;

    case 'history':
      renderHistory(msg.items || []);
      S.isRunning = !!msg.running;
      if (S.isRunning) showThinking();
      updateSendBtn();
      break;

    case 'cleared':
      clearScreen();
      S.isRunning = false;
      updateSendBtn();
      break;

    case 'user':
      // A prompt sent from another connected client/tab
      appendUserBubble(msg.text);
      break;

    case 'auth_url':
      // A login is in progress — make sure the login screen is up (it may be a
      // replay after a mid-login reconnect) and show the URL + code box.
      loginScreen.classList.remove('hidden');
      loginBtn.disabled = true;
      loginBtn.textContent = 'Waiting for sign-in…';
      loginUrlSect.classList.remove('hidden');
      loginUrlEl.href = msg.url;
      loginUrlEl.textContent = msg.url;
      loginCodeForm.classList.remove('hidden');
      loginCodeInput.focus();
      break;

    case 'text':
      hideThinking();
      appendAssistantText(msg.text);
      break;

    case 'tool_use':
      hideThinking();
      S.lastAssistantBubble = null;
      appendToolUse(msg.id, msg.name, msg.input);
      break;

    case 'tool_result':
      appendToolResult(msg.id, msg.output, msg.isError, msg.answered);
      // Still running → Claude is deciding its next step
      if (S.isRunning) showThinking();
      break;

    case 'permission_request':
      hideThinking();
      showPermissionPrompt(msg);
      break;

    case 'permission_resolved':
      // The server auto-approved this pending prompt (the user switched the mode
      // to Bypass/Accept edits mid-run) — just dismiss the card.
      if (pendingPerm && pendingPerm.id === msg.id) closePermission();
      break;

    case 'result':
      hideThinking();
      S.lastAssistantBubble = null;
      appendResultLine(msg);
      S.usage.turns       += msg.turns       || 0;
      S.usage.cost        += msg.cost        || 0;
      S.usage.inputTokens  += msg.inputTokens  || 0;
      S.usage.outputTokens += msg.outputTokens || 0;
      S.usage.cacheReadTokens  += msg.cacheReadTokens  || 0;
      S.usage.cacheWriteTokens += msg.cacheWriteTokens || 0;
      S.isRunning = false;
      updateSendBtn();
      break;

    case 'context_usage':
      S.ctxUsage = {
        totalTokens: msg.totalTokens || 0,
        maxTokens: msg.maxTokens || 0,
        autoCompactThreshold: msg.autoCompactThreshold || 0,
        autoCompactEnabled: !!msg.autoCompactEnabled,
      };
      updateCtxHint();
      break;

    case 'compacted':
      appendCompactedDivider(msg);
      break;

    case 'user_dialog':
      hideThinking();
      showUserDialog(msg);
      break;

    case 'user_dialog_cancelled':
      // Answered on another tab, or the turn was stopped — either way there's
      // nothing left to answer here.
      dropDialog(msg.id);
      break;

    case 'error':
      hideThinking();
      S.lastAssistantBubble = null;
      appendErrorBubble(msg.message);
      S.isRunning = false;
      updateSendBtn();
      break;

    case 'aborted':
      hideThinking();
      S.lastAssistantBubble = null;
      endToolGroup();
      S.isRunning = false;
      updateSendBtn();
      break;

    case 'auto_continue_state':
      autoContinueToggle.checked = !!msg.enabled;
      if (msg.supported != null) setAutoContinueSupported(!!msg.supported);
      if (!msg.enabled) hideAcBanner();
      break;

    case 'auto_continue_pending':
      S.limitOffer = null;
      showAcBanner(msg.resetsAt, msg.rateLimitType, msg.attempts);
      break;

    case 'auto_continue_cancelled':
      hideAcBanner();
      break;

    case 'limit_notice':
      appendLimitNotice(msg);
      break;

    case 'limit_offer':
      // A S.usage limit stopped the run and nothing is scheduled. Say when it
      // lifts, and offer to have the chat pick itself up then.
      S.limitOffer = { resetsAt: msg.resetsAt, supported: msg.supported !== false };
      showAcBanner(msg.resetsAt, msg.rateLimitType, 0, true);
      break;

    case 'limit_offer_cleared':
      S.limitOffer = null;
      hideAcBanner();
      break;

    case 'auto_continue_resuming':
      hideAcBanner();
      appendInfoLine('⏳ Usage limit reset — continuing automatically…');
      S.isRunning = true;
      updateSendBtn();
      showThinking();
      break;

    case 'auto_continue_gaveup':
      hideAcBanner();
      appendErrorBubble('Auto-continue stopped — still rate-limited after several attempts. Try again later.');
      S.isRunning = false;
      updateSendBtn();
      break;

    case 'rate_limit':
      // Live utilization telemetry; the banner is driven by the pending/cancel
      // messages, so nothing to render here for now.
      break;
  }
}
