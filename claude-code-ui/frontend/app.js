// Derive WebSocket URL from current page location so it works through HA ingress
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsBase  = location.pathname.replace(/\/+$/, '');
const wsUrl   = `${wsProto}//${location.host}${wsBase}/ws`;

let ws            = null;
let isConnected   = false;
let isRunning     = false;
let pendingPermId = null;

const loginScreen    = document.getElementById('login-screen');
const loginBtn       = document.getElementById('login-btn');
const loginUrlSect   = document.getElementById('login-url-section');
const loginUrlEl     = document.getElementById('login-url');
const loginCodeForm  = document.getElementById('login-code-form');
const loginCodeInput = document.getElementById('login-code-input');
const loginWaiting   = document.getElementById('login-waiting');
const messagesEl     = document.getElementById('messages');
const inputForm      = document.getElementById('input-form');
const promptInput    = document.getElementById('prompt-input');
const sendBtn        = document.getElementById('send-btn');
const statusDot      = document.getElementById('status-dot');
const permModeSelect = document.getElementById('perm-mode');
const newSessionBtn  = document.getElementById('new-session-btn');
const settingsBtn    = document.getElementById('settings-btn');
const settingsPanel  = document.getElementById('settings-panel');
const modelSelect    = document.getElementById('model-select');
const effortSelect   = document.getElementById('effort-select');
const autoContinueToggle = document.getElementById('auto-continue-toggle');
const autoContinueRow    = document.getElementById('auto-continue-row');
const autoContinueHint   = document.getElementById('auto-continue-hint');
const acBanner       = document.getElementById('auto-continue-banner');
const acBannerText   = document.getElementById('ac-banner-text');
const acBannerCancel = document.getElementById('ac-banner-cancel');
const sessionsBtn    = document.getElementById('sessions-btn');
const sessionsPanel  = document.getElementById('sessions-panel');
const sessionsListEl = document.getElementById('sessions-list');
const findBtn        = document.getElementById('find-btn');
const findBar        = document.getElementById('find-bar');
const findInput      = document.getElementById('find-input');
const findCount      = document.getElementById('find-count');
const findPrev       = document.getElementById('find-prev');
const findNext       = document.getElementById('find-next');
const findClose      = document.getElementById('find-close');
const permOverlay    = document.getElementById('permission-overlay');
const permTitle      = document.getElementById('perm-title');
const permToolChip   = document.getElementById('perm-tool-chip');
const permInputEl    = document.getElementById('perm-input');
const permAllow      = document.getElementById('perm-allow');
const permAlways     = document.getElementById('perm-always');
const permAlwaysHint = document.getElementById('perm-always-hint');
const permDeny       = document.getElementById('perm-deny');
const dialogOverlay  = document.getElementById('dialog-overlay');
const dialogTitle    = document.getElementById('dialog-title');
const dialogBody     = document.getElementById('dialog-body');
const dialogSubmit   = document.getElementById('dialog-submit');
const dialogCancel   = document.getElementById('dialog-cancel');

const cmdMenu = document.getElementById('cmd-menu');
const attachInput   = document.getElementById('attach-input');
const attachBtn     = document.getElementById('attach-btn');
const attachPreview = document.getElementById('attach-preview');

// ── Attachments ───────────────────────────────────────────────────────────────
// Files/photos the user attaches to the next prompt. Each: { file, name,
// mediaType, isImage, url } where url is an object URL used only for the preview.
let attachments = [];
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;   // ~25 MB total, keeps the WS message sane

function looksLikeImage(file) {
  return /^image\//.test(file.type || '') ||
    /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i.test(file.name || '');
}

function addFiles(fileList) {
  // Array.from (not for..of) so it works even if the webview's FileList isn't
  // iterable, and don't skip size===0 — some mobile pickers report 0 for
  // multi-selected photos that still read fine, so skipping them lost everything.
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let total = attachments.reduce((n, a) => n + (a.file.size || 0), 0);
  let added = 0, skipped = 0;
  for (const file of files) {
    if (!file) continue;
    const size = file.size || 0;
    if (size && total + size > MAX_ATTACH_BYTES) { skipped++; continue; }
    total += size;
    const isImage = looksLikeImage(file);
    let url = null;
    try { if (isImage) url = URL.createObjectURL(file); } catch {}
    attachments.push({ file, name: file.name || 'file', mediaType: file.type || '', isImage, url });
    added++;
  }
  if (skipped) appendErrorBubble(`${skipped} file${skipped > 1 ? 's' : ''} skipped — attachments are limited to ~25 MB total (images are shrunk automatically).`);
  if (!added && !skipped) appendErrorBubble('Could not attach the selected file(s).');
  renderAttachments();
  updateSendBtn();
}

function removeAttachment(i) {
  const a = attachments[i];
  if (a && a.url) URL.revokeObjectURL(a.url);
  attachments.splice(i, 1);
  renderAttachments();
  updateSendBtn();
}

function clearAttachments() {
  for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url);
  attachments = [];
  renderAttachments();
}

function renderAttachments() {
  attachPreview.innerHTML = '';
  if (!attachments.length) { attachPreview.classList.add('hidden'); return; }
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (a.isImage ? ' attach-chip-img' : '');
    if (a.isImage) {
      const img = document.createElement('img');
      img.src = a.url; img.alt = a.name;
      chip.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'attach-chip-name';
      label.textContent = a.name;
      chip.appendChild(label);
    }
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'attach-chip-remove'; rm.textContent = '✕';
    rm.title = 'Remove'; rm.onclick = () => removeAttachment(i);
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
  attachPreview.classList.remove('hidden');
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Images are downscaled to ~1568px (Claude's effective max useful edge) and
// re-encoded as JPEG before sending: this shrinks the payload dramatically (so
// several photos fit), and normalizes formats like HEIC to something Claude
// reads. Non-images (and anything that won't decode) are read as-is.
const MAX_IMG_DIM = 1568;
function fileToDataURL(file, isImage) {
  if (!isImage) return readFileAsDataURL(file);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_IMG_DIM / Math.max(img.width, img.height) || 1);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      } catch {
        URL.revokeObjectURL(url);
        readFileAsDataURL(file).then(resolve, () => resolve(null));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); readFileAsDataURL(file).then(resolve, () => resolve(null)); };
    img.src = url;
  });
}

attachBtn.onclick = () => attachInput.click();
attachInput.onchange = () => { addFiles(attachInput.files); attachInput.value = ''; };

// Paste an image (e.g. a screenshot) straight into the prompt.
promptInput.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// Drag-and-drop files onto the composer.
['dragenter', 'dragover'].forEach((ev) => inputForm.addEventListener(ev, (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    e.preventDefault(); inputForm.classList.add('dragover');
  }
}));
['dragleave', 'dragend'].forEach((ev) => inputForm.addEventListener(ev, (e) => {
  if (e.target === inputForm) inputForm.classList.remove('dragover');
}));
inputForm.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    e.preventDefault(); addFiles(e.dataTransfer.files);
  }
  inputForm.classList.remove('dragover');
});

// Track tool call elements (id → div) and last assistant bubble for accumulation
const toolCallEls = new Map();
let lastAssistantBubble = null;
let thinkingEl = null;
// The wrapper collecting a run of consecutive tool calls (null between runs)
let currentToolGroup = null;

// Session usage totals (for /usage), accumulated from result events
let usage = { messages: 0, turns: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// Multi-session state (sourced from Claude Code's on-disk store via the server)
let sessions = [];
let activeSessionId = null;

// ── Slash commands ───────────────────────────────────────────────────────────
// UI commands are handled locally and never sent to Claude.
const UI_COMMANDS = [
  { name: 'new',   desc: 'Start a new session', ui: true },
  { name: 'clear', desc: 'Clear the screen',    ui: true },
  { name: 'usage', desc: "Show this session's usage", ui: true },
  { name: 'resume', desc: 'Browse & resume past sessions', ui: true },
  { name: 'find',  desc: 'Find text in the chat', ui: true },
  { name: 'help',  desc: 'Show available commands', ui: true },
];
// Plugin/agent commands reported by the server; these pass through to Claude.
let pluginCommands = [];

// Autocomplete menu state
let menuItems = [];
let menuIndex = -1;

function allCommands() {
  const plugin = pluginCommands
    .filter((c) => !UI_COMMANDS.some((u) => u.name === c))
    .map((c) => ({ name: c, desc: '', ui: false }));
  return [...UI_COMMANDS, ...plugin];
}

const SEND_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;

// ── WebSocket ─────────────────────────────────────────────────────────────

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen    = () => { isConnected = true;  setStatus('connected'); };
  ws.onclose   = () => { isConnected = false; isRunning = false; setStatus('disconnected'); updateSendBtn(); setTimeout(connect, 3000); };
  ws.onerror   = () => ws.close();
  ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
}

const loginTitle = document.getElementById('login-title');
const loginDesc  = document.getElementById('login-desc');

function setAuthenticated(authenticated) {
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
function showReauth(subscription) {
  setAuthenticated(false);
  if (subscription === false) {
    // API-key auth: a device-flow login won't help, so point at the option.
    loginTitle.textContent = 'Authentication failed';
    loginDesc.textContent = 'Your Anthropic API key was rejected — check it in the add-on options.';
    loginBtn.classList.add('hidden');
  } else {
    loginTitle.textContent = 'Session expired';
    loginDesc.textContent = 'Your Claude sign-in has expired. Sign in again to continue.';
  }
}

loginBtn.onclick = () => {
  loginBtn.disabled = true;
  loginBtn.textContent = 'Opening…';
  ws.send(JSON.stringify({ type: 'auth_login' }));
};

loginCodeForm.onsubmit = (e) => {
  e.preventDefault();
  const code = loginCodeInput.value.trim();
  if (!code) return;
  ws.send(JSON.stringify({ type: 'auth_code', code }));
  loginCodeForm.classList.add('hidden');
  loginWaiting.classList.remove('hidden');
};

function handleServerMessage(msg) {
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
      pluginCommands = Array.isArray(msg.commands) ? msg.commands : [];
      break;

    case 'ha_links': {
      // Entity/automation link targets. These usually land just after the
      // history replay, so re-render already-rendered bubbles to pick up links.
      const had = haEntities.size;
      haEntities = new Set(Array.isArray(msg.entities) ? msg.entities : []);
      haAutomationIds = msg.automations || {};
      if (!had && haEntities.size) relinkRenderedBubbles();
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
      sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      activeSessionId = msg.activeId || null;
      if (!sessionsPanel.classList.contains('hidden')) renderSessions();
      break;

    case 'history':
      renderHistory(msg.items || []);
      isRunning = !!msg.running;
      if (isRunning) showThinking();
      updateSendBtn();
      break;

    case 'cleared':
      clearScreen();
      isRunning = false;
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
      lastAssistantBubble = null;
      appendToolUse(msg.id, msg.name, msg.input);
      break;

    case 'tool_result':
      appendToolResult(msg.id, msg.output, msg.isError);
      // Still running → Claude is deciding its next step
      if (isRunning) showThinking();
      break;

    case 'permission_request':
      hideThinking();
      showPermissionPrompt(msg);
      break;

    case 'permission_resolved':
      // The server auto-approved this pending prompt (the user switched the mode
      // to Bypass/Accept edits mid-run) — just dismiss the card.
      if (pendingPermId === msg.id) {
        pendingPermId = null;
        permOverlay.classList.add('hidden');
      }
      break;

    case 'result':
      hideThinking();
      lastAssistantBubble = null;
      appendResultLine(msg);
      usage.turns       += msg.turns       || 0;
      usage.cost        += msg.cost        || 0;
      usage.inputTokens  += msg.inputTokens  || 0;
      usage.outputTokens += msg.outputTokens || 0;
      usage.cacheReadTokens  += msg.cacheReadTokens  || 0;
      usage.cacheWriteTokens += msg.cacheWriteTokens || 0;
      isRunning = false;
      updateSendBtn();
      break;

    case 'context_usage':
      ctxUsage = {
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

    case 'error':
      hideThinking();
      lastAssistantBubble = null;
      appendErrorBubble(msg.message);
      isRunning = false;
      updateSendBtn();
      break;

    case 'aborted':
      hideThinking();
      lastAssistantBubble = null;
      endToolGroup();
      isRunning = false;
      updateSendBtn();
      break;

    case 'auto_continue_state':
      autoContinueToggle.checked = !!msg.enabled;
      if (msg.supported != null) setAutoContinueSupported(!!msg.supported);
      if (!msg.enabled) hideAcBanner();
      break;

    case 'auto_continue_pending':
      showAcBanner(msg.resetsAt, msg.rateLimitType, msg.attempts);
      break;

    case 'auto_continue_cancelled':
      hideAcBanner();
      break;

    case 'auto_continue_resuming':
      hideAcBanner();
      appendInfoLine('⏳ Usage limit reset — continuing automatically…');
      isRunning = true;
      updateSendBtn();
      showThinking();
      break;

    case 'auto_continue_gaveup':
      hideAcBanner();
      appendErrorBubble('Auto-continue stopped — still rate-limited after several attempts. Try again later.');
      isRunning = false;
      updateSendBtn();
      break;

    case 'rate_limit':
      // Live utilization telemetry; the banner is driven by the pending/cancel
      // messages, so nothing to render here for now.
      break;
  }
}

// ── Message rendering ──────────────────────────────────────────────────────

// Compact HH:MM timestamp shown on each message. `ts` (epoch ms) comes from the
// stored transcript on reload; live messages pass nothing and get stamped now.
function fmtTime(ms) {
  const d = ms ? new Date(ms) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function addTime(bubble, ts) {
  const t = document.createElement('span');
  t.className = 'msg-time';
  t.textContent = fmtTime(ts);
  t.title = (ts ? new Date(ts) : new Date()).toLocaleString();
  bubble.appendChild(t);
}

function appendUserBubble(text, ts, atts) {
  lastAssistantBubble = null;
  endToolGroup();
  const div = mkBubble('user');
  const content = div.querySelector('.bubble-content');
  // Attachment thumbnails/chips (live send only) above the text.
  if (atts && atts.length) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-attachments';
    for (const a of atts) {
      if (a.isImage && a.dataUrl) {
        const img = document.createElement('img');
        img.className = 'bubble-attach-img'; img.src = a.dataUrl; img.alt = a.name;
        wrap.appendChild(img);
      } else {
        const chip = document.createElement('span');
        chip.className = 'bubble-attach-file'; chip.textContent = '📎 ' + a.name;
        wrap.appendChild(chip);
      }
    }
    content.appendChild(wrap);
  }
  if (text) {
    const t = document.createElement('div');
    t.textContent = text;
    content.appendChild(t);
  }
  addTime(div, ts);
  messagesEl.appendChild(div);
  scrollBottom();
}

// ── Home Assistant deep links ────────────────────────────────────────────────
// The server sends the real entity ids (so we never link something that doesn't
// exist) and the automation entity_id → editor id map. We're served same-origin
// under HA ingress, so root-relative links resolve against whatever URL HA is on
// (local, Nabu Casa, …) — but they must target _top to escape the ingress iframe.
let haEntities = new Set();
let haAutomationIds = {};

// HA names its top window "ha-main-window" precisely so ingress iframes can find
// it (this mirrors the frontend's own src/common/dom/get_main_window.ts). Falls
// back to `top`, and to null if it's unreachable (cross-origin / standalone).
const HA_MAIN_WINDOW_NAME = 'ha-main-window';
function haMainWindow() {
  try {
    if (window.name === HA_MAIN_WINDOW_NAME) return window;
    if (window.parent && window.parent.name === HA_MAIN_WINDOW_NAME) return window.parent;
    return window.top || null;
  } catch { return null; }   // cross-origin — we're not inside HA
}

// Same shape as the frontend's fireEvent (bubbles + composed).
function haFire(target, type, detail) {
  target.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

// Open the entity's more-info dialog — exactly what clicking the entity anywhere
// in HA does, so each domain gets its usual controls (a switch gets its toggle,
// climate gets the thermostat, a sensor gets its history chart). It's a dialog,
// so nothing navigates: we stay inside the app/frontend.
function openMoreInfo(entityId) {
  const w = haMainWindow();
  if (!w) return false;
  try {
    const root = w.document.querySelector('home-assistant');
    if (!root) return false;
    haFire(root, 'hass-more-info', { entityId });
    return true;
  } catch { return false; }
}

// SPA-navigate the HA frontend, the way HA's own navigate() does — no page load,
// no handing the URL to an external browser.
function haNavigate(path) {
  const w = haMainWindow();
  if (!w) return false;
  try {
    w.history.pushState(null, '', path);
    haFire(w, 'location-changed', { replace: false });
    return true;
  } catch { return false; }
}

// Fallback URL, used for middle-click/copy-link and if we can't reach the HA
// frontend to open a dialog.
function haEntityUrl(id) {
  if (id.startsWith('automation.') && haAutomationIds[id]) {
    return `/config/automation/edit/${encodeURIComponent(haAutomationIds[id])}`;
  }
  return `/history?entity_id=${encodeURIComponent(id)}`;
}

function mkEntityLink(id) {
  const a = document.createElement('a');
  const isAutomation = id.startsWith('automation.') && haAutomationIds[id];
  a.className = 'ha-entity-link';
  a.href = haEntityUrl(id);       // real href: middle-click/copy still work
  a.target = '_top';
  a.rel = 'noopener';
  a.textContent = id;
  a.title = isAutomation ? `Edit automation ${id}` : `Open ${id} in Home Assistant`;
  a.addEventListener('click', (e) => {
    // Leave modified clicks (new tab/window) to the browser.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    // An automation you just made is most useful in its editor; everything else
    // opens its more-info dialog.
    const handled = isAutomation
      ? haNavigate(`/config/automation/edit/${encodeURIComponent(haAutomationIds[id])}`)
      : openMoreInfo(id);
    if (handled) e.preventDefault();   // otherwise fall through to the href
  });
  return a;
}

const ENTITY_RE = /\b[a-z_]+\.[a-z0-9_]+\b/g;

// Turn bare entity ids in the reply into links. Skips fenced code blocks (<pre>)
// so YAML stays clean and copy-pasteable, but does run inside inline <code>,
// which is where Claude usually names an entity.
function linkifyEntities(root) {
  if (!haEntities.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || n.nodeValue.indexOf('.') === -1) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest('a, pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue;
    let frag = null;
    let last = 0;
    let m;
    ENTITY_RE.lastIndex = 0;
    while ((m = ENTITY_RE.exec(text))) {
      if (!haEntities.has(m[0])) continue;
      frag = frag || document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(mkEntityLink(m[0]));
      last = m.index + m[0].length;
    }
    if (frag) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
}

// Links Claude writes itself (e.g. to a dashboard). Internal ones SPA-navigate
// the HA frontend so they open in the app rather than being handed to a browser;
// external ones open in a new tab.
function fixAnchorTargets(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    if (a.classList.contains('ha-entity-link')) continue;   // already wired
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (href.startsWith('/')) {
      a.target = '_top';
      a.rel = 'noopener';
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (haNavigate(href)) e.preventDefault();
      });
    }
  }
}

function renderMarkdown(el, raw) {
  el.innerHTML = marked.parse(raw);
  linkifyEntities(el);
  fixAnchorTargets(el);
  el.querySelectorAll('pre').forEach(addCopyButton);
}

// Copy text to the clipboard, with a fallback for non-secure contexts (the HA
// app / ingress isn't always a secure origin, where navigator.clipboard is
// undefined). Returns a promise resolving to true on success.
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }
  return new Promise((resolve) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    resolve(ok);
  });
}

// Add a small "Copy" button to a <pre> block. Captures the code text *before*
// inserting the button so the button's own label can't leak into the copy.
function addCopyButton(pre) {
  if (pre.querySelector(':scope > .copy-btn')) return;
  const codeEl = pre.querySelector('code');
  const text = (codeEl || pre).textContent;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.title = 'Copy to clipboard';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyText(text).then((ok) => {
      btn.textContent = ok ? 'Copied' : 'Failed';
      btn.classList.toggle('copied', ok);
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    });
  });
  pre.appendChild(btn);
}

// Re-render assistant bubbles from their stored markdown once link targets
// arrive (the map lands slightly after the history replay on connect).
function relinkRenderedBubbles() {
  for (const content of messagesEl.querySelectorAll('.bubble-assistant .bubble-content')) {
    if (content._rawMd) renderMarkdown(content, content._rawMd);
  }
}

function appendAssistantText(text, ts) {
  if (!lastAssistantBubble) {
    endToolGroup();
    lastAssistantBubble = mkBubble('assistant');
    addTime(lastAssistantBubble, ts);
    messagesEl.appendChild(lastAssistantBubble);
  }
  const content = lastAssistantBubble.querySelector('.bubble-content');
  content._rawMd = (content._rawMd || '') + text;
  renderMarkdown(content, content._rawMd);
  scrollBottom();
}

function appendToolUse(id, name, input) {
  const el = document.createElement('div');
  el.className = 'tool-call';

  const header = document.createElement('div');
  header.className = 'tool-call-header';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = '⚙';

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-call-name';
  nameEl.textContent = name;

  const summaryEl = document.createElement('span');
  summaryEl.className = 'tool-call-summary';
  summaryEl.textContent = getInputSummary(input);

  const statusEl = document.createElement('span');
  statusEl.className = 'tool-call-status status-running';

  const chevron = document.createElement('span');
  chevron.className = 'tool-call-chevron';
  chevron.textContent = '▾';

  header.append(icon, nameEl, summaryEl, statusEl, chevron);

  const body = document.createElement('div');
  body.className = 'tool-call-body';

  if (input && Object.keys(input).length > 0) {
    const pre = document.createElement('pre');
    pre.className = 'tool-call-input';
    const raw = JSON.stringify(input, null, 2);
    pre.textContent = raw.length > 600 ? raw.slice(0, 600) + '\n…' : raw;
    body.appendChild(pre);
    addCopyButton(pre);
  }

  el.append(header, body);
  header.onclick = () => el.classList.toggle('expanded');

  const group = ensureToolGroup();
  group._count++;
  group.querySelector('.tool-group-body').appendChild(el);
  group.querySelector('.tool-group-count').textContent =
    `${group._count} tool call${group._count !== 1 ? 's' : ''}`;
  if (group._count >= 2) group.querySelector('.tool-group-header').classList.remove('hidden');

  scrollBottom();

  toolCallEls.set(id, el);
}

// A run of consecutive tool calls shares one collapsible group. The group is
// created lazily on the first call and finalised (collapsed when it holds 2+
// calls) by endToolGroup() as soon as anything else interrupts the run.
function ensureToolGroup() {
  if (currentToolGroup) return currentToolGroup;
  const group = document.createElement('div');
  group.className = 'tool-group';
  group._count = 0;

  const gh = document.createElement('div');
  gh.className = 'tool-group-header hidden';
  gh.innerHTML =
    '<span class="tool-group-icon">⚙</span>' +
    '<span class="tool-group-count"></span>' +
    '<span class="tool-group-chevron">▾</span>';
  gh.onclick = () => group.classList.toggle('collapsed');

  const body = document.createElement('div');
  body.className = 'tool-group-body';

  group.append(gh, body);
  messagesEl.appendChild(group);
  currentToolGroup = group;
  return group;
}

function endToolGroup() {
  if (!currentToolGroup) return;
  // Collapse finished multi-call groups to declutter the transcript.
  if ((currentToolGroup._count || 0) >= 2) currentToolGroup.classList.add('collapsed');
  currentToolGroup = null;
}

function appendToolResult(id, output, isError) {
  const el = toolCallEls.get(id);
  toolCallEls.delete(id);

  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const truncated = text.length > 800 ? text.slice(0, 800) + '\n…' : text;

  if (el) {
    const statusEl = el.querySelector('.tool-call-status');
    statusEl.className = 'tool-call-status ' + (isError ? 'status-error' : 'status-done');

    const body = el.querySelector('.tool-call-body');
    const resultEl = document.createElement('pre');
    resultEl.className = 'tool-call-result' + (isError ? ' result-error' : '');
    resultEl.textContent = truncated;
    body.appendChild(resultEl);
    addCopyButton(resultEl);
  } else {
    const div = document.createElement('div');
    div.className = 'tool-result' + (isError ? ' tool-result-error' : '');
    const pre = document.createElement('pre');
    pre.textContent = truncated;
    div.appendChild(pre);
    addCopyButton(pre);
    messagesEl.appendChild(div);
    scrollBottom();
  }
}

function getInputSummary(input) {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input);
  if (!entries.length) return '';
  const [, val] = entries[0];
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  const head = s.length > 52 ? s.slice(0, 52) + '…' : s;
  return entries.length > 1 ? `${head}  +${entries.length - 1}` : head;
}

function appendResultLine({ success, turns }) {
  endToolGroup();
  const div = document.createElement('div');
  div.className = 'result-line';
  const parts = [success ? 'Done' : 'Finished with errors'];
  if (turns != null) parts.push(`${turns} turn${turns !== 1 ? 's' : ''}`);
  div.textContent = parts.join(' · ');
  messagesEl.appendChild(div);
  scrollBottom();
}

function appendCompactedDivider({ trigger, preTokens, postTokens }) {
  endToolGroup();
  lastAssistantBubble = null;
  const div = document.createElement('div');
  div.className = 'compacted-divider';
  let label = trigger === 'auto' ? 'Context auto-compacted' : 'Context compacted';
  if (preTokens && postTokens) label += ` — ${fmtTokens(preTokens)} → ${fmtTokens(postTokens)} tokens`;
  div.textContent = '⟳ ' + label;
  messagesEl.appendChild(div);
  scrollBottom();
}

function appendErrorBubble(message) {
  endToolGroup();
  const div = document.createElement('div');
  div.className = 'error-bubble';
  div.textContent = message;
  messagesEl.appendChild(div);
  scrollBottom();
}

// A neutral, centered status line in the transcript (e.g. an auto-continue note).
function appendInfoLine(text) {
  endToolGroup();
  lastAssistantBubble = null;
  const div = document.createElement('div');
  div.className = 'result-line';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollBottom();
}

function appendInfoBubble(text) {
  lastAssistantBubble = null;
  endToolGroup();
  const div = mkBubble('assistant');
  const content = div.querySelector('.bubble-content');
  content._rawMd = text;
  renderMarkdown(content, text);
  messagesEl.appendChild(div);
  scrollBottom();
}

// Rebuild the chat from a persisted transcript (on connect / reconnect)
function renderHistory(items) {
  clearScreen();
  for (const it of items) {
    switch (it.kind) {
      case 'user':        usage.messages++; appendUserBubble(it.text, it.ts); break;
      case 'text':        appendAssistantText(it.text, it.ts); break;
      case 'tool_use':    lastAssistantBubble = null; appendToolUse(it.id, it.name, it.input); break;
      case 'tool_result': appendToolResult(it.id, it.output, it.isError); break;
      case 'result':      lastAssistantBubble = null; appendResultLine(it);
                          usage.turns        += it.turns       || 0;
                          usage.cost         += it.cost        || 0;
                          usage.inputTokens  += it.inputTokens  || 0;
                          usage.outputTokens += it.outputTokens || 0;
                          usage.cacheReadTokens  += it.cacheReadTokens  || 0;
                          usage.cacheWriteTokens += it.cacheWriteTokens || 0;
                          break;
      case 'error':       lastAssistantBubble = null; appendErrorBubble(it.message); break;
    }
  }
  lastAssistantBubble = null;
  endToolGroup();   // finalise (and collapse) any trailing tool-call group
}

// ── Working indicator ────────────────────────────────────────────────────────
// The working indicator shows elapsed seconds so a long silent stretch (deep
// thinking, a slow tool, a retry/backoff, or auto-compaction) reads as "still
// going" rather than "stuck". The timer restarts each time the indicator
// reappears, so it measures the *current* wait.
let thinkingTimer = null;
function showThinking() {
  if (thinkingEl) { messagesEl.appendChild(thinkingEl); scrollBottom(); return; }
  const start = Date.now();
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.innerHTML =
    '<span class="thinking-dots"><i></i><i></i><i></i></span>' +
    '<span class="thinking-label">Working…</span>';
  messagesEl.appendChild(thinkingEl);
  const label = thinkingEl.querySelector('.thinking-label');
  thinkingTimer = setInterval(() => {
    if (!thinkingEl) return;
    const s = Math.round((Date.now() - start) / 1000);
    if (s >= 30) { label.textContent = `Working… ${s}s — long turns can take a minute or more`; thinkingEl.classList.add('slow'); }
    else if (s >= 3) label.textContent = `Working… ${s}s`;
  }, 1000);
  scrollBottom();
}
function hideThinking() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

// ── Model dropdown ───────────────────────────────────────────────────────────
const MODEL_LABELS = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};
// Real, cache-inclusive context-window usage reported by the SDK
// (query.getContextUsage), pushed after every turn. Drives the hint above the
// input showing progress toward auto-compaction.
let ctxUsage = null;   // { totalTokens, maxTokens, autoCompactThreshold, autoCompactEnabled }
const ctxTokensEl = document.getElementById('ctx-tokens');

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function updateCtxHint() {
  ctxTokensEl.classList.remove('ctx-warn', 'ctx-danger');
  if (!ctxUsage || !ctxUsage.totalTokens) { ctxTokensEl.classList.add('hidden'); return; }
  const { totalTokens, maxTokens, autoCompactThreshold, autoCompactEnabled } = ctxUsage;
  const compact = autoCompactEnabled && autoCompactThreshold;
  const limit = compact ? autoCompactThreshold : maxTokens;
  let text = `${fmtTokens(totalTokens)} tokens`;
  let pct = 0;
  if (limit) {
    pct = Math.min(100, Math.round(totalTokens / limit * 100));
    text += compact ? ` · ${pct}% to auto-compact` : ` · ${pct}% of ${fmtTokens(maxTokens)}`;
  }
  // As the window fills, warn — and once nearly full, nudge toward /compact,
  // since that's the point where a chat can appear to stall while it compacts.
  if (pct >= 95) { text += ' · run /compact'; ctxTokensEl.classList.add('ctx-danger'); }
  else if (pct >= 80) ctxTokensEl.classList.add('ctx-warn');
  ctxTokensEl.textContent = text;
  ctxTokensEl.classList.remove('hidden');
}
function ensureModelOption(id) {
  if ([...modelSelect.options].some((o) => o.value === id)) return;
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = MODEL_LABELS[id] || id;
  modelSelect.appendChild(opt);
}

// ── Sessions ─────────────────────────────────────────────────────────────────
function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function renderSessions() {
  sessionsListEl.innerHTML = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'sessions-empty';
    empty.textContent = 'No saved sessions yet.';
    sessionsListEl.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === activeSessionId ? ' active' : '');

    const main = document.createElement('div');
    main.className = 'session-main';
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = s.title;
    const time = document.createElement('div');
    time.className = 'session-time';
    time.textContent = relTime(s.updatedAt);
    main.append(title, time);

    const del = document.createElement('button');
    del.className = 'session-del';
    del.textContent = '✕';
    del.title = 'Delete session';
    del.onclick = (e) => {
      e.stopPropagation();
      if (confirm('Delete this session permanently?')) {
        if (ws && isConnected) ws.send(JSON.stringify({ type: 'session_delete', id: s.id }));
      }
    };

    item.onclick = () => {
      if (s.id !== activeSessionId && ws && isConnected) {
        ws.send(JSON.stringify({ type: 'session_switch', id: s.id }));
      }
      closeSessions();
    };

    item.append(main, del);
    sessionsListEl.appendChild(item);
  }
}

function openSessions() {
  if (ws && isConnected) ws.send(JSON.stringify({ type: 'sessions_list' }));
  renderSessions();
  sessionsPanel.classList.remove('hidden');
  sessionsBtn.classList.add('active');
}
function closeSessions() {
  sessionsPanel.classList.add('hidden');
  sessionsBtn.classList.remove('active');
}

// ── /usage ───────────────────────────────────────────────────────────────────
function showUsage() {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const lines = [
    `Messages sent: ${usage.messages}`,
    `Turns: ${usage.turns}  (tool calls each add a turn)`,
    ``,
    `Tokens (this chat):`,
    `  Input:        ${usage.inputTokens.toLocaleString()}`,
    `  Output:       ${usage.outputTokens.toLocaleString()}`,
    `  Cache read:   ${usage.cacheReadTokens.toLocaleString()}`,
    `  Cache write:  ${usage.cacheWriteTokens.toLocaleString()}`,
    `  Total:        ${totalTokens.toLocaleString()}`,
    ``,
    `Cost: $${usage.cost.toFixed(4)}`,
  ];
  appendInfoBubble(lines.join('\n'));
}

function mkBubble(role) {
  const div = document.createElement('div');
  div.className = `bubble bubble-${role}`;
  const content = document.createElement('div');
  content.className = 'bubble-content';
  div.appendChild(content);
  return div;
}

// ── Permission prompt ──────────────────────────────────────────────────────

function showPermissionPrompt({ id, toolName, input, title, canAlways, alwaysLabel }) {
  pendingPermId = id;
  permToolChip.textContent = toolName;
  permTitle.textContent = title || `Allow ${toolName}?`;
  const raw = JSON.stringify(input, null, 2);
  permInputEl.textContent = raw.length > 600 ? raw.slice(0, 600) + '\n…' : raw;
  // "Always" is only offered when the SDK supplied rules that would stop it
  // asking again; the label shows exactly what's being allowed from now on.
  permAlways.classList.toggle('hidden', !canAlways);
  permAlwaysHint.classList.toggle('hidden', !canAlways);
  if (canAlways) {
    permAlwaysHint.textContent = alwaysLabel
      ? `Always = don't ask again for: ${alwaysLabel}`
      : "Always = don't ask again for this tool";
  }
  permOverlay.classList.remove('hidden');
}

function resolvePermission(decision) {
  if (!pendingPermId) return;
  ws.send(JSON.stringify({ type: 'permission_response', id: pendingPermId, decision }));
  pendingPermId = null;
  permOverlay.classList.add('hidden');
}

permAllow.onclick  = () => resolvePermission('allow');
permAlways.onclick = () => resolvePermission('always');
permDeny.onclick   = () => resolvePermission('deny');

// Close on backdrop click
permOverlay.onclick = (e) => { if (e.target === permOverlay) resolvePermission('deny'); };

// ── User dialog (AskUserQuestion) ──────────────────────────────────────────
// The SDK surfaces interactive tools via onUserDialog. AskUserQuestion ships a
// `questions` array; we render an option picker and send the answers back.
let pendingDialogId = null;
let dialogQuestions = [];
let dialogSelections = [];   // per question: Set of chosen option labels

function showUserDialog({ id, payload }) {
  const questions = Array.isArray(payload?.questions) ? payload.questions
    : (payload && Array.isArray(payload.options)) ? [payload] : [];
  // Unrecognised dialog shapes must be cancelled per the SDK contract.
  if (!questions.length) { ws.send(JSON.stringify({ type: 'user_dialog_response', id })); return; }

  pendingDialogId = id;
  dialogQuestions = questions;
  dialogSelections = questions.map(() => new Set());
  dialogTitle.textContent = questions.length > 1 ? 'A few questions' : (questions[0].header || 'Question');
  dialogBody.innerHTML = '';

  questions.forEach((q, qi) => {
    const block = document.createElement('div');
    block.className = 'dialog-q';
    if (q.header && questions.length > 1) {
      const h = document.createElement('div');
      h.className = 'dialog-q-header';
      h.textContent = q.header;
      block.appendChild(h);
    }
    const qt = document.createElement('div');
    qt.className = 'dialog-q-text';
    qt.textContent = q.question || '';
    block.appendChild(qt);

    (q.options || []).forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dialog-option';
      const label = document.createElement('div');
      label.className = 'dialog-option-label';
      label.textContent = opt.label || '';
      btn.appendChild(label);
      if (opt.description) {
        const desc = document.createElement('div');
        desc.className = 'dialog-option-desc';
        desc.textContent = opt.description;
        btn.appendChild(desc);
      }
      btn.onclick = () => {
        const sel = dialogSelections[qi];
        if (q.multiSelect) {
          if (sel.has(opt.label)) sel.delete(opt.label); else sel.add(opt.label);
        } else {
          sel.clear(); sel.add(opt.label);
        }
        block.querySelectorAll('.dialog-option').forEach((b) => {
          b.classList.remove('selected');
          if (sel.has(b.querySelector('.dialog-option-label').textContent)) b.classList.add('selected');
        });
        updateDialogSubmit();
        // Single question, single-select → submit immediately for a fast path.
        if (!q.multiSelect && questions.length === 1) resolveUserDialog();
      };
      block.appendChild(btn);
    });
    dialogBody.appendChild(block);
  });

  updateDialogSubmit();
  dialogOverlay.classList.remove('hidden');
}

function updateDialogSubmit() {
  dialogSubmit.disabled = !dialogSelections.every((s) => s.size > 0);
}

function resolveUserDialog() {
  if (!pendingDialogId) return;
  // Result shape mirrors the AskUserQuestion answer contract: one entry per
  // question with the chosen option label(s). Verify against a logged request
  // (server logs `[onUserDialog]`) if the agent rejects the answer.
  const answers = dialogQuestions.map((q, qi) => {
    const chosen = [...dialogSelections[qi]];
    return {
      header: q.header,
      question: q.question,
      answer: q.multiSelect ? chosen : (chosen[0] ?? null),
    };
  });
  ws.send(JSON.stringify({ type: 'user_dialog_response', id: pendingDialogId, result: { answers } }));
  closeUserDialog();
}

function cancelUserDialog() {
  if (!pendingDialogId) return;
  ws.send(JSON.stringify({ type: 'user_dialog_response', id: pendingDialogId }));  // no result → cancelled
  closeUserDialog();
}

function closeUserDialog() {
  pendingDialogId = null;
  dialogQuestions = [];
  dialogSelections = [];
  dialogOverlay.classList.add('hidden');
}

dialogSubmit.onclick = () => resolveUserDialog();
dialogCancel.onclick = () => cancelUserDialog();
dialogOverlay.onclick = (e) => { if (e.target === dialogOverlay) cancelUserDialog(); };

// ── Input form ─────────────────────────────────────────────────────────────

sendBtn.onclick = (e) => {
  if (isRunning) {
    e.preventDefault();
    isRunning = false;
    hideThinking();
    updateSendBtn();
    if (ws && isConnected) ws.send(JSON.stringify({ type: 'abort' }));
  }
};

inputForm.onsubmit = async (e) => {
  e.preventDefault();
  hideCmdMenu();
  const text = promptInput.value.trim();
  const hasAtt = attachments.length > 0;
  if ((!text && !hasAtt) || !isConnected) return;

  // UI slash command? handle locally (only when there's no attachment).
  const ui = !hasAtt && UI_COMMANDS.find((c) => '/' + c.name === text);
  if (ui) {
    runUiCommand(ui.name);
    promptInput.value = '';
    localStorage.removeItem('draft');
    resizeTextarea();
    updateSendBtn();
    return;
  }

  if (isRunning) return;

  // Read the attachments to base64 for upload + the message bubble thumbnails.
  const pending = attachments.slice();
  let payload = [];
  let bubbleAtts = [];
  let readFailed = 0;
  for (const a of pending) {
    let dataUrl = null;
    try { dataUrl = await fileToDataURL(a.file, a.isImage); } catch { dataUrl = null; }
    if (!dataUrl) { readFailed++; continue; }
    // The media type / extension may have changed (e.g. an image re-encoded to JPEG).
    const mt = (dataUrl.match(/^data:([^;]+);/) || [])[1] || a.mediaType || 'application/octet-stream';
    let name = a.name;
    if (a.isImage && /jpeg/.test(mt) && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg';
    payload.push({ name, mediaType: mt, data: dataUrl });
    bubbleAtts.push({ name, isImage: a.isImage, dataUrl });
  }
  if (readFailed) appendErrorBubble(`${readFailed} attachment${readFailed > 1 ? 's' : ''} could not be read and ${readFailed > 1 ? 'were' : 'was'} skipped.`);
  if (!payload.length && !text) { updateSendBtn(); return; }   // nothing usable to send

  appendUserBubble(text, undefined, bubbleAtts);
  scrollBottom(true);   // sending a prompt re-pins to the bottom
  promptInput.value = '';
  localStorage.removeItem('draft');
  clearAttachments();
  resizeTextarea();
  isRunning = true;
  usage.messages++;
  updateSendBtn();
  showThinking();

  // Only send a model override if the user explicitly picked one; otherwise let
  // the SDK use its default (which it reports back via the 'model' event).
  ws.send(JSON.stringify({
    type: 'prompt',
    text,
    attachments: payload.length ? payload : undefined,
    permissionMode: permModeSelect.value,
    model: localStorage.getItem('model') || undefined,
    effort: localStorage.getItem('effort') || undefined,
  }));
};

function doNewSession() {
  clearScreen();
  isRunning = false;
  updateSendBtn();
  if (ws && isConnected) ws.send(JSON.stringify({ type: 'new_session' }));
}

function runUiCommand(name) {
  if (name === 'new')   doNewSession();
  else if (name === 'clear') clearScreen();
  else if (name === 'usage') showUsage();
  else if (name === 'resume') openSessions();
  else if (name === 'find')  openFind();
  else if (name === 'help')  showHelp();
}

// ── Find in chat ─────────────────────────────────────────────────────────────
let findHits = [];
let findIndex = -1;

function clearFindMarks() {
  const marks = messagesEl.querySelectorAll('mark.find-hit');
  marks.forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  if (marks.length) messagesEl.normalize();
  findHits = [];
  findIndex = -1;
}

function doFind() {
  clearFindMarks();
  const q = findInput.value;
  if (q) {
    const ql = q.toLowerCase();
    const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.toLowerCase().includes(ql)) nodes.push(n);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let last = 0, idx = lower.indexOf(ql);
      while (idx !== -1) {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        findHits.push(mark);
        last = idx + q.length;
        idx = lower.indexOf(ql, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    if (findHits.length) { findIndex = 0; setCurrentHit(); }
  }
  updateFindCount();
}

function setCurrentHit() {
  findHits.forEach((m) => m.classList.remove('find-current'));
  const m = findHits[findIndex];
  if (!m) return;
  m.classList.add('find-current');
  const tg = m.closest('.tool-group');
  if (tg) tg.classList.remove('collapsed');
  const tc = m.closest('.tool-call');
  if (tc && !tc.classList.contains('expanded')) tc.classList.add('expanded');
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function moveFind(delta) {
  if (!findHits.length) return;
  findIndex = (findIndex + delta + findHits.length) % findHits.length;
  setCurrentHit();
  updateFindCount();
}

function updateFindCount() {
  findCount.textContent = findHits.length ? `${findIndex + 1}/${findHits.length}` : '0/0';
}

function openFind() {
  findBar.classList.remove('hidden');
  findBtn.classList.add('active');
  findInput.focus();
  findInput.select();
  if (findInput.value) doFind();
}

function closeFind() {
  clearFindMarks();
  updateFindCount();
  findBar.classList.add('hidden');
  findBtn.classList.remove('active');
}

findBtn.onclick = () => {
  if (findBar.classList.contains('hidden')) openFind();
  else closeFind();
};
findInput.oninput = doFind;
findInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); moveFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
};
findPrev.onclick  = () => moveFind(-1);
findNext.onclick  = () => moveFind(1);
findClose.onclick = closeFind;

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openFind();
  }
});

// ── Command autocomplete menu ────────────────────────────────────────────────

function isMenuOpen() {
  return !cmdMenu.classList.contains('hidden');
}

function updateCmdMenu() {
  const m = promptInput.value.match(/^\/(\S*)$/);
  if (!m) { hideCmdMenu(); return; }
  const prefix = m[1].toLowerCase();
  menuItems = allCommands().filter((c) => c.name.toLowerCase().startsWith(prefix));
  if (!menuItems.length) { hideCmdMenu(); return; }
  menuIndex = 0;
  renderCmdMenu();
}

function renderCmdMenu() {
  cmdMenu.innerHTML = '';
  menuItems.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'cmd-item' + (i === menuIndex ? ' active' : '');

    const name = document.createElement('span');
    name.className = 'cmd-item-name';
    name.textContent = '/' + c.name;
    item.appendChild(name);

    if (c.desc) {
      const desc = document.createElement('span');
      desc.className = 'cmd-item-desc';
      desc.textContent = c.desc;
      item.appendChild(desc);
    }
    if (!c.ui) {
      const tag = document.createElement('span');
      tag.className = 'cmd-item-tag';
      tag.textContent = 'plugin';
      item.appendChild(tag);
    }

    item.onmousedown = (e) => { e.preventDefault(); completeFromMenu(i); };
    cmdMenu.appendChild(item);
  });
  cmdMenu.classList.remove('hidden');
}

function hideCmdMenu() {
  cmdMenu.classList.add('hidden');
  cmdMenu.innerHTML = '';
  menuItems = [];
  menuIndex = -1;
}

function moveMenu(delta) {
  if (!menuItems.length) return;
  menuIndex = (menuIndex + delta + menuItems.length) % menuItems.length;
  renderCmdMenu();
  const active = cmdMenu.querySelector('.cmd-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function completeFromMenu(i) {
  const c = menuItems[i];
  if (!c) return;
  hideCmdMenu();
  if (c.ui) {
    // UI commands run immediately on selection
    runUiCommand(c.name);
    promptInput.value = '';
  } else {
    // Plugin commands: fill in with a trailing space for optional args
    promptInput.value = '/' + c.name + ' ';
  }
  resizeTextarea();
  updateSendBtn();
  promptInput.focus();
}

function clearScreen() {
  messagesEl.innerHTML = '';
  toolCallEls.clear();
  lastAssistantBubble = null;
  currentToolGroup = null;
  thinkingEl = null;
  stickToBottom = true;   // a fresh/switched view starts pinned to the bottom
  usage = { messages: 0, turns: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  ctxUsage = null;
  updateCtxHint();
}

function showHelp() {
  const lines = allCommands().map((c) => `/${c.name}${c.desc ? '  —  ' + c.desc : '  (plugin command)'}`);
  appendInfoBubble('Available commands:\n' + lines.join('\n'));
}

newSessionBtn.onclick = () => {
  // The current session is preserved in the store (browsable via Sessions), so
  // only confirm if a query is actively running.
  if (isRunning && !confirm('A response is still running. Start a new chat anyway?')) return;
  doNewSession();
};

sessionsBtn.onclick = (e) => {
  e.stopPropagation();
  if (sessionsPanel.classList.contains('hidden')) openSessions();
  else closeSessions();
};

document.addEventListener('click', (e) => {
  if (sessionsPanel.classList.contains('hidden')) return;
  if (sessionsPanel.contains(e.target) || sessionsBtn.contains(e.target)) return;
  closeSessions();
});

// ── Settings panel ───────────────────────────────────────────────────────────
// Restore an explicit model choice if the user made one (else the dropdown
// syncs to whatever the server reports as the model in use via the 'model' event)
{
  const storedModel = localStorage.getItem('model');
  if (storedModel) { ensureModelOption(storedModel); modelSelect.value = storedModel; }
}
modelSelect.onchange = () => { localStorage.setItem('model', modelSelect.value); };

// Reasoning effort — empty string means "let the SDK/model decide" (no override).
effortSelect.value = localStorage.getItem('effort') || '';
effortSelect.onchange = () => { localStorage.setItem('effort', effortSelect.value); };

// Auto-continue on usage limit. State is owned by the server (persisted in /data
// so a resume fires even with no browser open), so we don't cache it locally —
// the 'config'/'auto_continue_state' messages drive the checkbox.
function setAutoContinueSupported(supported) {
  autoContinueRow.classList.toggle('disabled', !supported);
  autoContinueToggle.disabled = !supported;
  autoContinueHint.textContent = supported
    ? 'Resume automatically when the 5-hour usage limit resets.'
    : 'Only available when signed in with a Claude subscription (not an API key).';
}
autoContinueToggle.onchange = () => {
  if (ws && isConnected) {
    ws.send(JSON.stringify({ type: 'set_auto_continue', enabled: autoContinueToggle.checked }));
  }
};

// The banner counts down to the scheduled resume and offers a Cancel.
let acCountdownTimer = null;
function showAcBanner(resetsAt, rateLimitType, attempts) {
  if (acCountdownTimer) clearInterval(acCountdownTimer);
  const render = () => {
    const secs = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    const rel = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    const at = new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    acBannerText.textContent = secs > 0
      ? `Usage limit reached — auto-continuing at ${at} (in ${rel})`
      : 'Usage limit reset — resuming…';
  };
  render();
  acCountdownTimer = setInterval(render, 1000);
  acBanner.classList.remove('hidden');
}
function hideAcBanner() {
  if (acCountdownTimer) { clearInterval(acCountdownTimer); acCountdownTimer = null; }
  acBanner.classList.add('hidden');
}
acBannerCancel.onclick = () => {
  if (ws && isConnected) ws.send(JSON.stringify({ type: 'cancel_auto_continue' }));
  hideAcBanner();
};

// Restore + persist the permission mode so it survives navigating away. The
// add-on's default_permission_mode (sent as a 'config' message) fills in when
// the user hasn't chosen one yet.
permModeSelect.value = localStorage.getItem('permMode') || 'ask';
permModeSelect.onchange = () => {
  localStorage.setItem('permMode', permModeSelect.value);
  // Apply the change to an in-progress run immediately, not just the next prompt.
  if (isRunning && ws && isConnected) {
    ws.send(JSON.stringify({ type: 'set_perm_mode', mode: permModeSelect.value }));
  }
};

settingsBtn.onclick = (e) => {
  e.stopPropagation();
  const open = settingsPanel.classList.toggle('hidden');
  settingsBtn.classList.toggle('active', !open);
};

// Close the settings panel when clicking outside it
document.addEventListener('click', (e) => {
  if (settingsPanel.classList.contains('hidden')) return;
  if (settingsPanel.contains(e.target) || settingsBtn.contains(e.target)) return;
  settingsPanel.classList.add('hidden');
  settingsBtn.classList.remove('active');
});

promptInput.oninput = () => {
  resizeTextarea();
  updateSendBtn();
  updateCmdMenu();
  localStorage.setItem('draft', promptInput.value);
};

promptInput.onblur = () => setTimeout(hideCmdMenu, 120);

promptInput.onkeydown = (e) => {
  if (isMenuOpen()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveMenu(1);  return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveMenu(-1); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      completeFromMenu(menuIndex);
      return;
    }
    if (e.key === 'Escape')    { e.preventDefault(); hideCmdMenu(); return; }
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    inputForm.dispatchEvent(new Event('submit'));
  }
};

function resizeTextarea() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
}

function updateSendBtn() {
  if (isRunning) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.setAttribute('aria-label', 'Stop');
    sendBtn.classList.add('stop');
  } else {
    sendBtn.disabled = (!promptInput.value.trim() && !attachments.length) || !isConnected;
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.classList.remove('stop');
  }
}

function setStatus(state) {
  statusDot.className = `status-dot ${state}`;
}

// Auto-scroll only when the user is already pinned to the bottom. If they've
// scrolled up to read or copy something, incoming responses must NOT yank them
// back down. `stickToBottom` tracks whether the viewport is at (or near) the
// bottom; it's updated on every user scroll and re-armed when the user sends a
// prompt or the screen is reset. Pass force=true to re-pin explicitly.
let stickToBottom = true;
const SCROLL_STICK_PX = 80;   // within this many px of the bottom counts as "at bottom"

// Auto-hide the header on small screens: collapse it when scrolling down through
// a long chat (to reclaim space), slide it back in on any upward scroll (so the
// user doesn't have to scroll all the way to the top to reach settings). CSS
// keeps the header pinned on large screens.
const headerEl = document.querySelector('.header');
let lastScrollTop = 0;
let headerLockTimer = null;

// Toggling the header changes the messages viewport height, which makes the
// browser re-clamp scrollTop and fire more scroll events — near the bottom that
// feeds back and oscillates the header. So after each toggle we ignore scroll
// events until the collapse/expand animation settles, then re-baseline.
function setHeaderHidden(hidden) {
  if (headerEl.classList.contains('header-hidden') === hidden) return;
  headerEl.classList.toggle('header-hidden', hidden);
  if (headerLockTimer) clearTimeout(headerLockTimer);
  headerLockTimer = setTimeout(() => {
    headerLockTimer = null;
    lastScrollTop = messagesEl.scrollTop;
  }, 350);
}

messagesEl.addEventListener('scroll', () => {
  const st = messagesEl.scrollTop;
  const dist = messagesEl.scrollHeight - st - messagesEl.clientHeight;
  stickToBottom = dist <= SCROLL_STICK_PX;

  // Auto-hide is a small-screen affordance; CSS pins the header on wide screens.
  if (window.innerWidth >= 700) { lastScrollTop = st; return; }
  if (headerLockTimer) return;   // let a toggle settle before reacting again

  const delta = st - lastScrollTop;
  if (st < 40) setHeaderHidden(false);            // near the top → always show
  else if (dist < 90) { /* near the bottom → leave as-is (avoids clamp feedback) */ }
  else if (delta > 10) setHeaderHidden(true);     // clear downward move → hide
  else if (delta < -10) setHeaderHidden(false);   // clear upward move → reveal
  lastScrollTop = st;
});

function scrollBottom(force) {
  if (force) stickToBottom = true;
  if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Start ──────────────────────────────────────────────────────────────────

// Restore any draft the user was typing before navigating away
{
  const draft = localStorage.getItem('draft');
  if (draft) { promptInput.value = draft; resizeTextarea(); updateSendBtn(); }
}

connect();
