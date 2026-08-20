/*
 * Claude authentication: whether we have credentials, whether a failure was an
 * auth failure, and the device-login flow.
 *
 * The login process is deliberately owned by the server rather than by the
 * socket that started it — on a phone, switching to the browser to paste the
 * code drops the WebSocket, and the login has to survive that.
 */
import { existsSync, statSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { CLAUDE_CONFIG_DIR } from './config.js';

const CREDENTIALS_FILE = () => path.join(CLAUDE_CONFIG_DIR, '.credentials.json');

export function isAuthenticated() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  return existsSync(CREDENTIALS_FILE());
}

/** Does a query error look like an authentication failure, or a normal one? */
export function isAuthError(msg) {
  const m = (msg || '').toLowerCase();
  return m.includes('oauth')
    || m.includes('unauthorized') || m.includes(' 401') || m.includes('401 ')
    || m.includes('authentication_error') || m.includes('invalid api key')
    || m.includes('invalid bearer') || m.includes('/login') || m.includes('please run')
    || m.includes('re-authenticate') || m.includes('reauthenticate')
    || (m.includes('token') && m.includes('expired'))
    || (m.includes('credential') && (m.includes('expired') || m.includes('invalid')));
}

/**
 * Subscription (claude.ai sign-in) vs API-key auth. Auto-continue only applies
 * to subscription auth: the SDK's `rate_limit_event` carries a `resetsAt` reset
 * time, whereas API-key usage surfaces plain 429s with nothing to schedule
 * against.
 */
export function isSubscriptionAuth() {
  return !process.env.ANTHROPIC_API_KEY && existsSync(CREDENTIALS_FILE());
}

// One active login shared across all connections. `url` is kept so a client that
// reconnects mid-login can be shown the code box again.
const login = { proc: null, pollInterval: null, url: null, startedAt: 0 };

export const loginUrl = () => (login.proc ? login.url : null);

/** The live login process, for writing the pasted code to its stdin. */
export const loginProcess = () => login.proc;

export function stopLoginProc() {
  if (login.pollInterval) { clearInterval(login.pollInterval); login.pollInterval = null; }
  if (login.proc) { try { login.proc.kill(); } catch {} login.proc = null; }
  login.url = null;
}

/**
 * A login only counts as successful when NEW credentials are written by *this*
 * login. During re-auth the old, expired file still exists, so plain existence
 * would report success before the user has pasted anything.
 */
function loginSucceeded() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try { return existsSync(CREDENTIALS_FILE()) && statSync(CREDENTIALS_FILE()).mtimeMs >= login.startedAt; }
  catch { return false; }
}

function startPolling(onSuccess) {
  if (login.pollInterval) return;
  login.pollInterval = setInterval(() => {
    if (loginSucceeded()) { stopLoginProc(); onSuccess(); }
  }, 2000);
}

/**
 * Start the device-login flow. `notifyAll` receives the login URL when it is
 * captured and the success message when credentials land; `onSuccess` clears the
 * expired-credentials flag.
 */
export function startLoginFlow(notifyAll, onSuccess) {
  stopLoginProc();
  login.startedAt = Date.now();

  login.proc = spawn('claude', ['auth', 'login'], {
    env: { ...process.env, BROWSER: '/opt/scripts/browser-capture.sh', DISPLAY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const URL_RE = /https?:\/\/[^\s\n"'<>]+/;
  const succeeded = () => { onSuccess(); notifyAll({ type: 'auth_status', authenticated: true }); };
  let sentUrl = false;

  function tryCapture(chunk) {
    if (sentUrl) return;
    const text = chunk.toString();
    // BROWSER_URL: prefix from our capture script, or a raw URL in the output.
    const tagged = text.match(/BROWSER_URL:(https?:\/\/[^\s\n]+)/);
    const raw = text.match(URL_RE);
    const url = (tagged && tagged[1]) || (raw && raw[0]);
    if (url) {
      sentUrl = true;
      login.url = url;
      notifyAll({ type: 'auth_url', url });
      startPolling(succeeded);
    }
  }

  login.proc.stdout.on('data', tryCapture);
  login.proc.stderr.on('data', tryCapture);

  login.proc.on('exit', () => {
    login.proc = null;
    if (loginSucceeded()) { stopLoginProc(); succeeded(); }
  });
}
