/*
 * Scrolling. Auto-scroll only when the user is already pinned to the bottom: if
 * they have scrolled up to read something, an incoming response must not yank them
 * back down.
 */
import { S } from './state.js';
import { messagesEl } from './dom.js';
import { markProgrammaticScroll, onMessagesScroll } from './promptnav.js';

export const SCROLL_STICK_PX = 80;   // within this many px of the bottom counts as "at bottom"

// Set while the transcript is being rebuilt wholesale (renderHistory), so the
// dozens of appends that rebuild does don't each drag the viewport around.

// Auto-hide the header on small screens: collapse it when scrolling down through
// a long chat (to reclaim space), slide it back in on any upward scroll (so the
// user doesn't have to scroll all the way to the top to reach settings). CSS
// keeps the header pinned on large screens.
export const headerEl = document.querySelector('.header');
export let lastScrollTop = 0;
export let headerLockTimer = null;

// Toggling the header changes the messages viewport height, which makes the
// browser re-clamp scrollTop and fire more scroll events — near the bottom that
// feeds back and oscillates the header. So after each toggle we ignore scroll
// events until the collapse/expand animation settles, then re-baseline.
export function setHeaderHidden(hidden) {
  if (headerEl.classList.contains('header-hidden') === hidden) return;
  headerEl.classList.toggle('header-hidden', hidden);
  if (headerLockTimer) clearTimeout(headerLockTimer);
  headerLockTimer = setTimeout(() => {
    headerLockTimer = null;
    lastScrollTop = messagesEl.scrollTop;
  }, 350);
}

messagesEl.addEventListener('scroll', () => {
  onMessagesScroll();
  const st = messagesEl.scrollTop;
  const dist = messagesEl.scrollHeight - st - messagesEl.clientHeight;
  S.stickToBottom = dist <= SCROLL_STICK_PX;

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

export function scrollBottom(force) {
  if (force) S.stickToBottom = true;
  if (S.suppressAutoScroll) return;
  if (S.stickToBottom) {
    markProgrammaticScroll();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}
