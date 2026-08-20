/*
 * The ↑/↓ arrows that step through your own messages in a long chat.
 */
import { messagesEl, promptNextBtn, promptPrevBtn } from './dom.js';

// ── Prompt navigation (↑/↓) ──────────────────────────────────────────────────
// Step through your own messages — the landmarks you actually scroll a long
// chat looking for. The arrows appear on a real scroll gesture and fade after a
// couple of seconds of stillness, so they're never just sitting on the screen.

// The app's own scrolling (following a streaming reply, or a jump) is not a
// gesture: without this, every streamed token would flash the arrows on.
export let programmaticScrollAt = 0;
export function markProgrammaticScroll() { programmaticScrollAt = Date.now(); }
export function isProgrammaticScroll() { return Date.now() - programmaticScrollAt < 400; }

// Deliberately re-queried rather than kept as a list: clearScreen() and a
// history replay both replace every node, and a stale array of detached bubbles
// is exactly the bug this would otherwise invite. Memoised on something cheap
// that changes whenever the transcript does.
export let promptCache = { key: '', nodes: [] };
export function userPrompts() {
  const key = String(messagesEl.childElementCount);
  if (promptCache.key !== key) {
    promptCache = { key, nodes: [...messagesEl.querySelectorAll('.bubble-user')] };
  }
  return promptCache.nodes;
}

// A prompt within this many px of the top edge counts as "the one you're on",
// so a jump landing exactly on the boundary can't bounce back on the next press.
export const NAV_EDGE = 8;

export function promptOffset(node, containerTop) {
  return node.getBoundingClientRect().top - containerTop;
}

// Prompt tops increase in document order, so "first/last past the edge" is a
// binary search — this runs off a scroll handler and must stay cheap.
export function findNextPrompt(nodes) {
  if (!nodes.length) return null;
  const top = messagesEl.getBoundingClientRect().top;
  let lo = 0, hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (promptOffset(nodes[mid], top) > NAV_EDGE) hi = mid; else lo = mid + 1;
  }
  return lo < nodes.length ? nodes[lo] : null;
}

export function findPrevPrompt(nodes) {
  if (!nodes.length) return null;
  const top = messagesEl.getBoundingClientRect().top;
  let lo = -1, hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (promptOffset(nodes[mid], top) < -NAV_EDGE) lo = mid; else hi = mid - 1;
  }
  return lo >= 0 ? nodes[lo] : null;
}

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function jumpToNode(node) {
  if (!node || !node.isConnected) return;
  markProgrammaticScroll();
  node.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
}

// Each arrow hides independently when there's nothing left that way — which is
// what makes reaching an end unambiguous rather than dimmed-but-still-there.
export function refreshPromptNav() {
  const nodes = userPrompts();
  // Having a target below isn't enough: at the very bottom of the scroll range
  // nothing more can be brought up to the top edge, so the last prompt still
  // counts as "next" while pressing it visibly does nothing.
  const atMax = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 2;
  promptPrevBtn.classList.toggle('hidden', !findPrevPrompt(nodes));
  promptNextBtn.classList.toggle('hidden', atMax || !findNextPrompt(nodes));
}

export const NAV_IDLE_MS = 2200;
export let navIdleTimer = null;

export function hidePromptNav() {
  promptPrevBtn.classList.add('hidden');
  promptNextBtn.classList.add('hidden');
  clearTimeout(navIdleTimer);
  navIdleTimer = null;
}

export function wakePromptNav() {
  refreshPromptNav();
  clearTimeout(navIdleTimer);
  navIdleTimer = setTimeout(hidePromptNav, NAV_IDLE_MS);
}

// rAF-throttled for the same reason the header auto-hide is: refreshPromptNav
// reads layout, and doing that on every scroll event forces a reflow per frame.
export let navFrame = null;
export function onMessagesScroll() {
  if (isProgrammaticScroll()) return;
  if (messagesEl.scrollHeight - messagesEl.clientHeight <= 0) return;
  if (navFrame) return;
  navFrame = requestAnimationFrame(() => {
    navFrame = null;
    wakePromptNav();
  });
}

for (const btn of [promptPrevBtn, promptNextBtn]) {
  // A press must not leave focus (and its ring) sitting on the button after the
  // arrows have faded away.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('mouseenter', () => { clearTimeout(navIdleTimer); navIdleTimer = null; });
  btn.addEventListener('mouseleave', () => {
    clearTimeout(navIdleTimer);
    navIdleTimer = setTimeout(hidePromptNav, NAV_IDLE_MS);
  });
}
promptPrevBtn.addEventListener('click', () => { jumpToNode(findPrevPrompt(userPrompts())); wakePromptNav(); });
promptNextBtn.addEventListener('click', () => { jumpToNode(findNextPrompt(userPrompts())); wakePromptNav(); });

// ── Start ──────────────────────────────────────────────────────────────────

// Restore any draft the user was typing before navigating away
