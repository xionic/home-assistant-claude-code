/*
 * Who may call /diag — a Home Assistant admin, proved against Home Assistant.
 *
 * The diagnostic routes are not read-only curiosities: /diag/query and /diag/feed
 * run a real agent turn with every tool auto-approved, which is code execution on
 * the box with write access to /config, and /diag/grep and /diag/sesslist hand
 * back conversation transcripts. They used to be reachable by anything that could
 * open a socket to the app's port — other apps, Core, the Supervisor. This is what
 * closes that.
 *
 * The caller presents a Home Assistant **long-lived access token** in an
 * `Authorization: Bearer` header, and it must belong to an **admin** user.
 *
 * Two decisions worth not re-litigating:
 *
 *  1. **Validated against Core directly, never the Supervisor proxy.** Measured:
 *     `http://supervisor/core/api/` answers 200 to this app's own SUPERVISOR_TOKEN,
 *     so validating there would accept the add-on's own credentials — and every
 *     other app's — as though they were a user's key. Core at homeassistant:8123
 *     answers 401 to that same token and 200 only to real Core tokens.
 *
 *  2. **One WebSocket round-trip does both jobs.** The `auth` handshake proves the
 *     token is genuine (`auth_ok` vs `auth_invalid`), and `auth/current_user` then
 *     reports `is_admin`. There is no REST endpoint for the second part, so the
 *     WebSocket is not an optimisation — it is the only route.
 *
 * The token is never logged. Cache keys are SHA-256 digests, so a heap dump or a
 * stray log line cannot leak the credential either.
 */
import { createHash } from 'crypto';
import { WebSocket } from 'ws';
import { HA_CORE_WS_URL } from './config.js';
import { log, vlog } from './log.js';

/** How long a decision is trusted. Long enough that /diag/query pays the
 *  round-trip once, short enough that revoking a token takes effect promptly. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 5000;

/** digest → { verdict, expires }. Negative verdicts are cached too, so a loop
 *  hammering the endpoint cannot turn into a loop hammering Home Assistant. */
const cache = new Map();

const digest = (token) => createHash('sha256').update(token).digest('hex');

/** Enough of the digest to correlate log lines, never enough to be a credential. */
const tag = (d) => d.slice(0, 8);

/**
 * Ask Home Assistant who owns this token.
 *
 * Resolves to one of:
 *   { ok: true,  isAdmin, user }   the token is genuine
 *   { ok: false, reason: 'invalid' }      Home Assistant rejected it
 *   { ok: false, reason: 'unreachable' }  we could not ask — caller must fail closed
 */
export function validateHaToken(token) {
  return new Promise((resolve) => {
    let ws;
    let settled = false;

    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already gone */ }
      resolve(verdict);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'unreachable' }), HANDSHAKE_TIMEOUT_MS);

    try {
      ws = new WebSocket(HA_CORE_WS_URL);
    } catch (e) {
      vlog(`ha-auth: could not open ${HA_CORE_WS_URL}: ${e?.message || e}`);
      return finish({ ok: false, reason: 'unreachable' });
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'auth_required') {
        return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      }
      if (msg.type === 'auth_invalid') {
        return finish({ ok: false, reason: 'invalid' });
      }
      if (msg.type === 'auth_ok') {
        // Genuine. Now: whose token is it, and are they an admin?
        return ws.send(JSON.stringify({ id: 1, type: 'auth/current_user' }));
      }
      if (msg.type === 'result' && msg.id === 1) {
        if (!msg.success) return finish({ ok: false, reason: 'unreachable' });
        return finish({ ok: true, isAdmin: !!msg.result?.is_admin, user: msg.result?.name });
      }
    });

    // A refused connection, a DNS failure, a Core that is still starting.
    ws.on('error', (e) => {
      vlog(`ha-auth: websocket error: ${e?.message || e}`);
      finish({ ok: false, reason: 'unreachable' });
    });
    ws.on('close', () => finish({ ok: false, reason: 'unreachable' }));
  });
}

/** Cached wrapper. Only definite answers are cached — never 'unreachable', which
 *  is a transient condition and must be retried rather than remembered. */
async function verdictFor(token) {
  const d = digest(token);
  const hit = cache.get(d);
  if (hit && hit.expires > Date.now()) return hit.verdict;

  const verdict = await validateHaToken(token);
  if (verdict.reason !== 'unreachable') {
    cache.set(d, { verdict, expires: Date.now() + CACHE_TTL_MS });
  }
  return verdict;
}

/** The bearer token from an Authorization header, or null. */
function bearer(req) {
  const header = req.get?.('authorization') || req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Express middleware: require a Home Assistant admin's access token.
 *
 * Header only — a `?token=` query parameter was considered and rejected, because
 * it would put the credential in shell history, proxy logs and the app log.
 *
 * Fails closed: if Home Assistant cannot be reached we refuse rather than assume.
 */
export async function requireHaAdmin(req, res, next) {
  const token = bearer(req);
  if (!token) {
    log('WARN', `diag: ${req.path} refused — no bearer token`);
    return res.status(401).json({
      error: 'unauthorized',
      detail: 'Send a Home Assistant long-lived access token: Authorization: Bearer <token>. ' +
        'It must belong to an admin user.',
    });
  }

  const d = tag(digest(token));
  let verdict;
  try {
    verdict = await verdictFor(token);
  } catch (e) {
    // Belt and braces: validateHaToken resolves rather than rejects, so this is
    // only reachable if something above it throws. Still fail closed.
    log('WARN', `diag: ${req.path} refused — validation threw (token ${d}): ${e?.message || e}`);
    return res.status(503).json({ error: 'auth_unavailable' });
  }

  if (verdict.reason === 'unreachable') {
    log('WARN', `diag: ${req.path} refused — could not reach Home Assistant to validate (token ${d})`);
    return res.status(503).json({
      error: 'auth_unavailable',
      detail: 'Could not reach Home Assistant to validate the token.',
    });
  }
  if (!verdict.ok) {
    log('WARN', `diag: ${req.path} refused — Home Assistant rejected the token (${d})`);
    return res.status(401).json({ error: 'unauthorized', detail: 'Home Assistant rejected that token.' });
  }
  if (!verdict.isAdmin) {
    log('WARN', `diag: ${req.path} refused — token ${d} is valid but not an admin`);
    return res.status(403).json({ error: 'forbidden', detail: 'That token does not belong to an admin user.' });
  }

  vlog(`diag: ${req.path} allowed for ${verdict.user || 'an admin'} (token ${d})`);
  return next();
}

/** Testing seam: drop cached verdicts so a test can change a fake's answer. */
export function clearHaAuthCache() {
  cache.clear();
}
