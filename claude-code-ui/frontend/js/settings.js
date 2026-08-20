/*
 * The settings panel: model, reasoning effort, and the auto-continue toggle.
 * 
 * Auto-continue state is owned by the server (persisted, so a resume fires with no
 * browser open), so nothing is cached here — the server's messages drive the box.
 */
import { S } from './state.js';
import { autoContinueHint, autoContinueRow, autoContinueToggle, effortSelect, modelSelect } from './dom.js';
import { ensureModelOption } from './model.js';

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

// Auto-continue on S.usage limit. State is owned by the server (persisted in /data
// so a resume fires even with no browser open), so we don't cache it locally —
// the 'config'/'auto_continue_state' messages drive the checkbox.
export function setAutoContinueSupported(supported) {
  autoContinueRow.classList.toggle('disabled', !supported);
  autoContinueToggle.disabled = !supported;
  autoContinueHint.textContent = supported
    ? 'Resume automatically when the 5-hour usage limit resets.'
    : 'Only available when signed in with a Claude subscription (not an API key).';
}
autoContinueToggle.onchange = () => {
  if (S.ws && S.isConnected) {
    S.ws.send(JSON.stringify({ type: 'set_auto_continue', enabled: autoContinueToggle.checked }));
  }
};

// A S.usage limit stops a chat mid-thought, and the only thing worth knowing
// afterwards is whether anything is going to pick it up. This banner answers
// that and stays current as the clock moves — in two modes:
//   scheduled — a resume is armed; it counts down and offers a Cancel.
//   offer     — nothing is armed (auto-continue is off); it says when the limit
//               lifts and offers to have the chat carry on by itself then.
// `S.limitOffer` is the standing offer, if any, so turning the toggle on from
// anywhere schedules *this* limit rather than only affecting the next one.
