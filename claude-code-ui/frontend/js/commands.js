/*
 * Slash commands — the app's own, plus whatever the server reports from plugins —
 * and the autocomplete menu that offers them.
 */
import { S } from './state.js';
import { requestNewSession, resizeTextarea, runUiCommand, updateSendBtn } from './composer.js';
import { cmdMenu, messagesEl, newSessionBtn, promptInput, sessionsBtn, sessionsPanel } from './dom.js';
import { updateCtxHint } from './model.js';

import { closeSessions, openSessions } from './sessions.js';
import { appendInfoBubble, toolCallEls } from './transcript.js';

// ── Slash commands ───────────────────────────────────────────────────────────
// UI commands are handled locally and never sent to Claude.
export const UI_COMMANDS = [
  { name: 'new',   desc: 'Start a new session', ui: true },
  { name: 'clear', desc: 'Clear the screen',    ui: true },
  { name: 'usage', desc: "Show this session's usage", ui: true },
  { name: 'resume', desc: 'Browse & resume past sessions', ui: true },
  { name: 'find',  desc: 'Find text in the chat', ui: true },
  { name: 'help',  desc: 'Show available commands', ui: true },
];
// Plugin/agent commands reported by the server; these pass through to Claude.

// Autocomplete menu state
export let menuItems = [];
export let menuIndex = -1;

export function allCommands() {
  const plugin = S.pluginCommands
    .filter((c) => !UI_COMMANDS.some((u) => u.name === c))
    .map((c) => ({ name: c, desc: '', ui: false }));
  return [...UI_COMMANDS, ...plugin];
}

export const SEND_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
export const STOP_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;

// ── /usage ───────────────────────────────────────────────────────────────────
export function showUsage() {
  const totalTokens = S.usage.inputTokens + S.usage.outputTokens;
  const lines = [
    `Messages sent: ${S.usage.messages}`,
    `Turns: ${S.usage.turns}  (tool calls each add a turn)`,
    ``,
    `Tokens (this chat):`,
    `  Input:        ${S.usage.inputTokens.toLocaleString()}`,
    `  Output:       ${S.usage.outputTokens.toLocaleString()}`,
    `  Cache read:   ${S.usage.cacheReadTokens.toLocaleString()}`,
    `  Cache write:  ${S.usage.cacheWriteTokens.toLocaleString()}`,
    `  Total:        ${totalTokens.toLocaleString()}`,
    ``,
    `Cost: $${S.usage.cost.toFixed(4)}`,
  ];
  appendInfoBubble(lines.join('\n'));
}

// ── Command autocomplete menu ────────────────────────────────────────────────

export function isMenuOpen() {
  return !cmdMenu.classList.contains('hidden');
}

export function updateCmdMenu() {
  const m = promptInput.value.match(/^\/(\S*)$/);
  if (!m) { hideCmdMenu(); return; }
  const prefix = m[1].toLowerCase();
  menuItems = allCommands().filter((c) => c.name.toLowerCase().startsWith(prefix));
  if (!menuItems.length) { hideCmdMenu(); return; }
  menuIndex = 0;
  renderCmdMenu();
}

export function renderCmdMenu() {
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

export function hideCmdMenu() {
  cmdMenu.classList.add('hidden');
  cmdMenu.innerHTML = '';
  menuItems = [];
  menuIndex = -1;
}

export function moveMenu(delta) {
  if (!menuItems.length) return;
  menuIndex = (menuIndex + delta + menuItems.length) % menuItems.length;
  renderCmdMenu();
  const active = cmdMenu.querySelector('.cmd-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

export function completeFromMenu(i) {
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

export function clearScreen() {
  messagesEl.innerHTML = '';
  toolCallEls.clear();
  S.lastAssistantBubble = null;
  S.currentToolGroup = null;
  S.thinkingEl = null;
  S.stickToBottom = true;   // a fresh/switched view starts pinned to the bottom
  S.usage = { messages: 0, turns: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  S.ctxUsage = null;
  updateCtxHint();
}

export function showHelp() {
  const lines = allCommands().map((c) => `/${c.name}${c.desc ? '  —  ' + c.desc : '  (plugin command)'}`);
  appendInfoBubble('Available commands:\n' + lines.join('\n'));
}

// The current session is preserved in the store (browsable via Sessions), so
// requestNewSession only asks when a query is actively running.
newSessionBtn.onclick = () => { requestNewSession(); };

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
