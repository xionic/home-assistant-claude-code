/*
 * A yes/no the app asks on its own account, before doing something that throws
 * work away.
 *
 * Distinct from the permission card and the question dialog it shares markup
 * with: those relay something Claude asked and send an answer back over the
 * socket. This one has no protocol behind it. It exists because `session_switch`
 * and `new_session` both abort the running turn on the server, and doing that
 * without saying so is indistinguishable from the app losing the reply.
 *
 * A native confirm() would do the job, but it renders as a system alert inside
 * the Home Assistant companion app's WebView, where it reads as coming from
 * somewhere other than this app.
 */
import { confirmOverlay, confirmTitle, confirmBody, confirmYes, confirmNo } from './dom.js';

let resolveCurrent = null;

function close(answer) {
  if (!resolveCurrent) return;
  const resolve = resolveCurrent;
  resolveCurrent = null;
  confirmOverlay.classList.add('hidden');
  resolve(answer);
}

confirmYes.onclick = () => close(true);
confirmNo.onclick = () => close(false);

// Every way out other than the affirmative button means no. The destructive
// branch is never the default, so a stray tap on the backdrop cannot stop a
// running turn.
//
// The card swallows its own clicks: without this they reach the document, where
// the handler that closes the Sessions panel on an outside click would shut the
// panel behind the dialog — so cancelling would still leave the user somewhere
// they didn't choose to be.
confirmOverlay.onclick = (e) => {
  e.stopPropagation();
  if (e.target === confirmOverlay) close(false);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && resolveCurrent) { e.preventDefault(); close(false); }
});

/**
 * Ask, and resolve to whether the user went ahead.
 *
 * `danger` colours the affirmative button as the consequential choice, which is
 * what these all are; pass false for a confirmation that isn't destructive.
 */
export function confirmAction({ title, body, confirm, cancel = 'Cancel', danger = true }) {
  // A second question while one is open would strand the first caller's promise,
  // and its caller would sit waiting on a dialog nobody can see.
  close(false);

  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmYes.textContent = confirm;
  confirmNo.textContent = cancel;
  confirmYes.classList.toggle('btn-danger', danger);
  confirmYes.classList.toggle('btn-allow', !danger);

  confirmOverlay.classList.remove('hidden');
  confirmNo.focus();   // Enter keeps things as they are

  return new Promise((resolve) => { resolveCurrent = resolve; });
}

/** The warning shared by every route that abandons a turn in progress. */
export function confirmInterrupt({ body, confirm }) {
  return confirmAction({
    title: 'Claude is still working',
    body,
    confirm,
    cancel: 'Stay here',
  });
}
