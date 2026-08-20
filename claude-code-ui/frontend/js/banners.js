/*
 * The usage-limit banner. A limit stops a chat mid-thought, and the only thing
 * worth knowing afterwards is whether anything is going to pick it up.
 */
import { S } from './state.js';
import { completeFromMenu, hideCmdMenu, isMenuOpen, menuIndex, moveMenu, updateCmdMenu } from './commands.js';
import { resizeTextarea, updateSendBtn } from './composer.js';
import { acBanner, acBannerCancel, acBannerEnable, acBannerText, autoContinueToggle, inputForm, messagesEl, permModeSelect, promptInput, settingsBtn, settingsPanel } from './dom.js';
import { scrollBottom } from './scroll.js';
import { endToolGroup } from './transcript.js';

export let acCountdownTimer = null;

export function limitWhen(resetsAt) {
  const secs = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  const at = new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return { secs, at, rel: h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s` };
}

export function showAcBanner(resetsAt, rateLimitType, attempts, isOffer) {
  if (acCountdownTimer) clearInterval(acCountdownTimer);
  const supported = !isOffer || !S.limitOffer || S.limitOffer.supported;
  const render = () => {
    const { secs, at, rel } = limitWhen(resetsAt);
    if (isOffer) {
      acBannerText.textContent = secs > 0
        ? `Usage limit — resets at ${at} (in ${rel}). Nothing will happen until then unless you send a prompt.`
        : `Usage limit reset at ${at} — send a prompt to carry on.`;
    } else {
      acBannerText.textContent = secs > 0
        ? `Usage limit reached — auto-continuing at ${at} (in ${rel})`
        : 'Usage limit reset — resuming…';
    }
  };
  render();
  acCountdownTimer = setInterval(render, 1000);
  acBannerEnable.classList.toggle('hidden', !isOffer || !supported);
  acBannerCancel.classList.toggle('hidden', !!isOffer);
  acBanner.classList.toggle('ac-banner-offer', !!isOffer);
  acBanner.classList.remove('hidden');
}

export function hideAcBanner() {
  if (acCountdownTimer) { clearInterval(acCountdownTimer); acCountdownTimer = null; }
  acBanner.classList.add('hidden');
}

acBannerCancel.onclick = () => {
  if (S.ws && S.isConnected) S.ws.send(JSON.stringify({ type: 'cancel_auto_continue' }));
  hideAcBanner();
};

// Turning the toggle on is all this does: the server schedules the resume for
// the limit that's still in force, and answers with auto_continue_pending, which
// swaps this banner into its counting-down form.
acBannerEnable.onclick = () => {
  if (!S.ws || !S.isConnected) return;
  acBannerEnable.disabled = true;
  autoContinueToggle.checked = true;
  S.ws.send(JSON.stringify({ type: 'set_auto_continue', enabled: true }));
  setTimeout(() => { acBannerEnable.disabled = false; }, 1500);
};

// The banner scrolls with nothing and is gone after a reload; this marks the
// place in the conversation where it actually broke off, and is still there
// tomorrow morning.
export function appendLimitNotice({ resetsAt, scheduled, supported }) {
  endToolGroup();
  S.lastAssistantBubble = null;
  // Replace any earlier notice for the same limit rather than stacking them.
  messagesEl.querySelectorAll('.limit-notice').forEach((n) => n.remove());
  const { at } = limitWhen(resetsAt);
  const div = document.createElement('div');
  div.className = 'limit-notice';

  const head = document.createElement('div');
  head.className = 'limit-notice-head';
  head.textContent = '⏳ Usage limit reached';
  div.appendChild(head);

  const when = document.createElement('div');
  when.textContent = resetsAt ? `It resets at ${at}.` : 'It will reset shortly.';
  div.appendChild(when);

  const outcome = document.createElement('div');
  outcome.className = scheduled ? 'limit-notice-ok' : 'limit-notice-off';
  outcome.textContent = scheduled
    ? `This chat will carry on by itself at ${at} — you can close this page.`
    : supported
      ? 'Auto-continue is off, so nothing will happen until you send another prompt.'
      : 'Auto-continue needs a Claude subscription sign-in, so nothing will happen until you send another prompt.';
  div.appendChild(outcome);

  messagesEl.appendChild(div);
  scrollBottom();
}

// Restore + persist the permission mode so it survives navigating away. The
// app's default_permission_mode (sent as a 'config' message) fills in when
// the user hasn't chosen one yet.
permModeSelect.value = localStorage.getItem('permMode') || 'ask';
permModeSelect.onchange = () => {
  localStorage.setItem('permMode', permModeSelect.value);
  // Apply the change to an in-progress run immediately, not just the next prompt.
  if (S.isRunning && S.ws && S.isConnected) {
    S.ws.send(JSON.stringify({ type: 'set_perm_mode', mode: permModeSelect.value }));
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
