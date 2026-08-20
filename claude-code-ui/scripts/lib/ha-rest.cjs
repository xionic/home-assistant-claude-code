/*
 * ha-rest — the Supervisor REST calls ha-tools needs.
 *
 * Most things are better done over the WebSocket API (see lib/ha-ws.cjs), but a
 * few live only on REST — notably config validation, which has no WebSocket
 * equivalent and was previously something an agent had to hand-roll with curl.
 *
 * Auth is $SUPERVISOR_TOKEN. HA_SUPERVISOR_URL overrides the host for testing.
 */
const BASE = process.env.HA_SUPERVISOR_URL || 'http://supervisor';

function token() {
  const t = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
  if (!t) throw new Error('no SUPERVISOR_TOKEN or HA_TOKEN in environment');
  return t;
}

/**
 * Call a Core REST endpoint (paths are relative to /core/api). Throws on a
 * non-2xx status with the body attached — an error body must never be returned
 * as if it were data, which is the trap that hid the removal of /api/error_log.
 */
async function core(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const url = `${BASE}/core/api/${path.replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      e.name === 'AbortError' ? `${method} ${url} timed out after ${timeoutMs}ms` : `${method} ${url}: ${e.message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = text ? ` — ${text.slice(0, 300).replace(/\s+/g, ' ').trim()}` : '';
    throw new Error(`${method} ${url} returned HTTP ${res.status}${detail}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

module.exports = { core };
