/*
 * Every element the app touches, looked up once.
 * 
 * The app is served from the Home Assistant ingress path, so the WebSocket URL is
 * derived from the page location rather than hardcoded.
 */

// Derive WebSocket URL from current page location so it works through HA ingress
export const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
export const wsBase  = location.pathname.replace(/\/+$/, '');
export const wsUrl   = `${wsProto}//${location.host}${wsBase}/ws`;

export const loginScreen    = document.getElementById('login-screen');
export const loginBtn       = document.getElementById('login-btn');
export const loginUrlSect   = document.getElementById('login-url-section');
export const loginUrlEl     = document.getElementById('login-url');
export const loginCodeForm  = document.getElementById('login-code-form');
export const loginCodeInput = document.getElementById('login-code-input');
export const loginWaiting   = document.getElementById('login-waiting');
export const messagesEl     = document.getElementById('messages');
export const inputForm      = document.getElementById('input-form');
export const promptInput    = document.getElementById('prompt-input');
export const sendBtn        = document.getElementById('send-btn');
export const statusDot      = document.getElementById('status-dot');
export const permModeSelect = document.getElementById('perm-mode');
export const newSessionBtn  = document.getElementById('new-session-btn');
export const settingsBtn    = document.getElementById('settings-btn');
export const settingsPanel  = document.getElementById('settings-panel');
export const modelSelect    = document.getElementById('model-select');
export const effortSelect   = document.getElementById('effort-select');
export const autoContinueToggle = document.getElementById('auto-continue-toggle');
export const autoContinueRow    = document.getElementById('auto-continue-row');
export const autoContinueHint   = document.getElementById('auto-continue-hint');
export const acBanner       = document.getElementById('auto-continue-banner');
export const acBannerText   = document.getElementById('ac-banner-text');
export const acBannerCancel = document.getElementById('ac-banner-cancel');
export const acBannerEnable = document.getElementById('ac-banner-enable');
export const sessionsBtn    = document.getElementById('sessions-btn');
export const sessionsPanel  = document.getElementById('sessions-panel');
export const sessionsListEl = document.getElementById('sessions-list');
export const findBtn        = document.getElementById('find-btn');
export const findBar        = document.getElementById('find-bar');
export const findInput      = document.getElementById('find-input');
export const findCount      = document.getElementById('find-count');
export const findPrev       = document.getElementById('find-prev');
export const findNext       = document.getElementById('find-next');
export const findClose      = document.getElementById('find-close');
export const permOverlay    = document.getElementById('permission-overlay');
export const permTitle      = document.getElementById('perm-title');
export const permToolChip   = document.getElementById('perm-tool-chip');
export const permInputEl    = document.getElementById('perm-input');
export const permAllow      = document.getElementById('perm-allow');
export const permAlways     = document.getElementById('perm-always');
export const permAlwaysHint = document.getElementById('perm-always-hint');
export const permDeny       = document.getElementById('perm-deny');
export const permLater      = document.getElementById('perm-later');
export const dialogOverlay  = document.getElementById('dialog-overlay');
export const dialogTitle    = document.getElementById('dialog-title');
export const dialogBody     = document.getElementById('dialog-body');
export const dialogSubmit   = document.getElementById('dialog-submit');
export const dialogSkip     = document.getElementById('dialog-skip');
export const dialogBack     = document.getElementById('dialog-back');
export const dialogLater    = document.getElementById('dialog-later');
export const dialogProgress = document.getElementById('dialog-progress');
export const confirmOverlay = document.getElementById('confirm-overlay');
export const confirmTitle   = document.getElementById('confirm-title');
export const confirmBody    = document.getElementById('confirm-body');
export const confirmYes     = document.getElementById('confirm-yes');
export const confirmNo      = document.getElementById('confirm-no');
export const chatScroll     = document.getElementById('chat-scroll');
export const promptPrevBtn  = document.getElementById('prompt-prev');
export const promptNextBtn  = document.getElementById('prompt-next');
export const questionStrip     = document.getElementById('question-strip');
export const questionStripText = document.getElementById('question-strip-text');
export const questionStripOpen = document.getElementById('question-strip-open');

export const cmdMenu = document.getElementById('cmd-menu');
export const attachInput   = document.getElementById('attach-input');
export const attachBtn     = document.getElementById('attach-btn');
export const attachPreview = document.getElementById('attach-preview');

export const loginTitle = document.getElementById('login-title');
export const loginDesc  = document.getElementById('login-desc');
