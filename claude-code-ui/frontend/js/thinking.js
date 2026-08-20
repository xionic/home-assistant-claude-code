/*
 * The working indicator, with elapsed seconds. Long silent thinking is the usual
 * cause of the "chat looks stuck" perception, so the count is the reassurance.
 */
import { S } from './state.js';
import { messagesEl } from './dom.js';
import { scrollBottom } from './scroll.js';

// ── Working indicator ────────────────────────────────────────────────────────
// The working indicator shows elapsed seconds so a long silent stretch (deep
// thinking, a slow tool, a retry/backoff, or auto-compaction) reads as "still
// going" rather than "stuck". The timer restarts each time the indicator
// reappears, so it measures the *current* wait.
export let thinkingTimer = null;
export function showThinking() {
  if (S.thinkingEl) { messagesEl.appendChild(S.thinkingEl); scrollBottom(); return; }
  const start = Date.now();
  S.thinkingEl = document.createElement('div');
  S.thinkingEl.className = 'thinking';
  S.thinkingEl.innerHTML =
    '<span class="thinking-dots"><i></i><i></i><i></i></span>' +
    '<span class="thinking-label">Working…</span>';
  messagesEl.appendChild(S.thinkingEl);
  const label = S.thinkingEl.querySelector('.thinking-label');
  thinkingTimer = setInterval(() => {
    if (!S.thinkingEl) return;
    const s = Math.round((Date.now() - start) / 1000);
    if (s >= 30) { label.textContent = `Working… ${s}s — long turns can take a minute or more`; S.thinkingEl.classList.add('slow'); }
    else if (s >= 3) label.textContent = `Working… ${s}s`;
  }, 1000);
  scrollBottom();
}
export function hideThinking() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  if (S.thinkingEl) { S.thinkingEl.remove(); S.thinkingEl = null; }
}
