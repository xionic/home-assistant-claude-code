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

/**
 * Fetch a Supervisor endpoint that answers in plain text — the journald log
 * endpoints. Same contract as core(): a non-2xx throws with the body attached.
 *
 * The trap this guards against has two forms. The first is returning an error
 * body as if it were data, which is how the removal of /api/error_log went
 * unnoticed. The second is subtler and is why the log is read at all: treating a
 * *success* body as a complete verdict. `check_config` answers "valid" for a
 * config it has just logged errors about — an endpoint's silence about errors is
 * not evidence of their absence.
 */
async function supervisorText(path, { query = {}, timeoutMs = 30000 } = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}/${path.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}`, Accept: 'text/plain' },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      e.name === 'AbortError' ? `GET ${url} timed out after ${timeoutMs}ms` : `GET ${url}: ${e.message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = text ? ` — ${text.slice(0, 200).replace(/\s+/g, ' ').trim()}` : '';
    throw new Error(`GET ${url} returned HTTP ${res.status}${detail}`);
  }
  return text;
}

/** The tail of Home Assistant Core's log, as ha-logs reads it. */
function coreLogTail(lines = 400) {
  return supervisorText('core/logs', { query: { lines } });
}

module.exports = { core, supervisorText, coreLogTail };
