/*
 * Auto-continue on a usage-limit reset (subscription auth only).
 *
 * When a claude.ai subscription 5-hour limit is hit mid-run, the SDK emits a
 * `rate_limit_event` with status 'rejected' and a `resetsAt` epoch. If the user
 * has enabled auto-continue we persist that and resume the conversation once the
 * limit resets. Only the 5-hour limit is auto-resumed — waiting out a 7-day
 * limit unattended is rarely what anyone wants.
 *
 * The state is server-owned and persisted, because the whole point is that the
 * resume fires with no browser open.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  AUTO_CONTINUE_FILE, AUTO_CONTINUE_BUFFER_MS, AUTO_CONTINUE_MAX_ATTEMPTS,
  AUTO_CONTINUE_PROMPT, LIMIT_OFFER_GRACE_MS,
} from './config.js';
import { log, vlog } from './log.js';
import { broadcast } from './broadcast.js';
import { runtime } from './state.js';
import { isSubscriptionAuth } from './auth.js';
import { autoResumeState } from './permissions.js';

/**
 * `enabled` is the user toggle; `pending` is a scheduled resume; `offer` is the
 * other half — a limit that stopped a run while auto-continue was *off*. Nothing
 * is scheduled for an offer, but the reset time is worth keeping: it is what
 * lets the UI say when the limit lifts and offer to pick the run up then.
 */
export const autoContinue = { enabled: false, pending: null, offer: null };

let timer = null;

// Injected by index.js — run-query.js imports this module, so importing it back
// would be a cycle. Keeping the dependency one-way and explicit is clearer than
// relying on hoisting to resolve it.
let runQuery = null;
export function setResumeRunner(fn) { runQuery = fn; }

export function load() {
  try {
    if (existsSync(AUTO_CONTINUE_FILE)) {
      const d = JSON.parse(readFileSync(AUTO_CONTINUE_FILE, 'utf8'));
      autoContinue.enabled = !!d.enabled;
      autoContinue.pending = d.pending || null;
      autoContinue.offer = d.offer || null;
    }
  } catch (e) { console.warn('Could not load auto-continue state:', e.message); }
}

export function save() {
  try { writeFileSync(AUTO_CONTINUE_FILE, JSON.stringify(autoContinue)); }
  catch (e) { console.warn('Could not save auto-continue state:', e.message); }
}

/** The offer, if it still means anything: same session, and not long past. */
export function liveLimitOffer() {
  const o = autoContinue.offer;
  if (!o || !runtime.activeSessionId) return null;
  if (o.sessionId && o.sessionId !== runtime.activeSessionId) return null;
  if (Date.now() > o.resetsAt * 1000 + LIMIT_OFFER_GRACE_MS) return null;
  return o;
}

export function clearLimitOffer(reason) {
  if (!autoContinue.offer) return;
  autoContinue.offer = null;
  save();
  vlog(`limit offer cleared (${reason})`);
  broadcast({ type: 'limit_offer_cleared' });
}

function clearTimer() {
  if (timer) { clearTimeout(timer); timer = null; }
}

export function isTimerArmed() { return !!timer; }

/**
 * Arm (or re-arm) a resume. Safe to call on startup: the delay is recomputed
 * from `resetsAt`, so a reset that already elapsed during downtime fires almost
 * immediately. setTimeout's ~24.8-day ceiling comfortably covers a 5-hour wait.
 */
export function schedule(pending) {
  clearTimer();
  autoContinue.pending = pending;
  save();
  const fireAt = pending.resetsAt * 1000 + AUTO_CONTINUE_BUFFER_MS;
  const delay = Math.max(0, fireAt - Date.now());
  log('INFO', `auto-continue: ${pending.rateLimitType} limit hit; resuming at ` +
    `${new Date(fireAt).toISOString()} (in ${Math.round(delay / 1000)}s, attempt ${pending.attempts})`);
  broadcast({ type: 'auto_continue_pending', resetsAt: pending.resetsAt,
    rateLimitType: pending.rateLimitType, attempts: pending.attempts });
  timer = setTimeout(fire, delay);
}

export function cancel(reason) {
  clearTimer();
  if (!autoContinue.pending) return;
  autoContinue.pending = null;
  save();
  log('INFO', `auto-continue: pending resume cancelled (${reason})`);
  broadcast({ type: 'auto_continue_cancelled', reason });
}

function fire() {
  clearTimer();
  const pending = autoContinue.pending;
  if (!pending) return;
  if (!autoContinue.enabled) return cancel('disabled');
  if (!isSubscriptionAuth()) return cancel('not-subscription');
  if (!runtime.activeSessionId) return cancel('no-active-session');
  // A run is somehow already active — wait and retry rather than overlap it.
  if (runtime.activeQuery) { timer = setTimeout(fire, 30000); return; }

  autoContinue.pending = null;
  save();
  log('INFO', `auto-continue: resuming session ${runtime.activeSessionId} (attempt ${pending.attempts})`);
  broadcast({ type: 'auto_continue_resuming', attempts: pending.attempts });

  // Headless run: a fake never-open socket, so send() no-ops and it is not in
  // `connections`. Its user message still broadcasts to real tabs.
  runQuery({ readyState: 3 }, autoResumeState, {
    text: AUTO_CONTINUE_PROMPT,
    permissionMode: pending.permissionMode,
    model: pending.model,
    effort: pending.effort,
    autoAttempts: pending.attempts,
  });
}

/** Turning the toggle on while a limit is still in force schedules *that*
 *  resume, not just the next one — which is the point of offering the switch at
 *  the moment you find out you have been cut off. */
export function setEnabled(enabled) {
  autoContinue.enabled = !!enabled;
  save();
  log('INFO', `auto-continue ${autoContinue.enabled ? 'enabled' : 'disabled'}`);
  broadcast({ type: 'auto_continue_state', enabled: autoContinue.enabled, supported: isSubscriptionAuth() });

  if (!autoContinue.enabled) return cancel('disabled');

  const offer = liveLimitOffer();
  if (offer && isSubscriptionAuth() && !autoContinue.pending && !runtime.activeQuery) {
    autoContinue.offer = null;
    broadcast({ type: 'limit_offer_cleared' });
    schedule(offer);
  }
}

/**
 * What to do when a run ends having hit a 5-hour limit: mark the place in the
 * conversation where it stopped, and either schedule the resume or remember
 * enough to schedule one if the user turns the toggle on after reading the
 * notice.
 */
export function handleLimitHit(limitHit, { model, effort, permissionMode, autoAttempts }) {
  const supported = isSubscriptionAuth();
  const willResume = autoContinue.enabled && supported && autoAttempts < AUTO_CONTINUE_MAX_ATTEMPTS;

  broadcast({
    type: 'limit_notice',
    resetsAt: limitHit.resetsAt,
    rateLimitType: limitHit.rateLimitType,
    scheduled: willResume,
    supported,
  });

  if (autoContinue.enabled && supported) {
    const attempts = autoAttempts + 1;
    if (attempts > AUTO_CONTINUE_MAX_ATTEMPTS) {
      log('WARN', `auto-continue: still limited after ${AUTO_CONTINUE_MAX_ATTEMPTS} attempts — giving up`);
      broadcast({ type: 'auto_continue_gaveup', attempts: AUTO_CONTINUE_MAX_ATTEMPTS });
      autoContinue.pending = null;
      save();
    } else {
      clearLimitOffer('scheduled');
      schedule({
        resetsAt: limitHit.resetsAt,
        rateLimitType: limitHit.rateLimitType,
        model: model || null,
        effort: effort || null,
        permissionMode,
        attempts,
      });
    }
    return;
  }

  log('INFO', `usage limit hit; auto-continue ${autoContinue.enabled ? 'needs subscription auth' : 'is off'}`);
  autoContinue.offer = {
    resetsAt: limitHit.resetsAt,
    rateLimitType: limitHit.rateLimitType,
    model: model || null,
    effort: effort || null,
    permissionMode,
    attempts: autoAttempts + 1,
    sessionId: runtime.activeSessionId,
  };
  save();
  broadcast({ type: 'limit_offer', resetsAt: limitHit.resetsAt, rateLimitType: limitHit.rateLimitType, supported });
}

/**
 * Re-arm a resume scheduled before a restart (it fires almost immediately if its
 * reset elapsed while we were down); otherwise drop a now-ineligible pending.
 */
export function rearmOnBoot() {
  if (!autoContinue.pending) return;
  if (autoContinue.enabled && isSubscriptionAuth() && runtime.activeSessionId &&
      autoContinue.pending.attempts <= AUTO_CONTINUE_MAX_ATTEMPTS) {
    schedule(autoContinue.pending);
  } else {
    autoContinue.pending = null;
    save();
  }
}
