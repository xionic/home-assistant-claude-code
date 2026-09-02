/*
 * ha-log-scan — read the errors Home Assistant reports about itself.
 *
 * Why this exists: `POST /core/api/config/core/check_config` answers a narrower
 * question than its name suggests. It fails only on errors that stop the config
 * being *loaded* — YAML parse errors, core schema violations. An error inside an
 * integration's per-entity config is non-fatal by design: HA logs it, drops that
 * entity, and carries on. So the endpoint returns
 * `{"result":"valid","errors":null}` for a config that will silently be missing
 * the entity you just wrote, which is the opposite of what a safety check is for.
 *
 * The information is not missing, only unreported: HA writes
 *
 *   Invalid config for 'template' at templates/blind.yaml, line 21:
 *     'position_template' is an invalid option for 'template', …
 *
 * to the Core log *during the very check that returns "valid"*. So the fix is to
 * read what the operation emits rather than only what it returns.
 *
 * Everything here is pure: the caller fetches the log before and after, and
 * these functions work out what is new and what it means. That keeps the fiddly
 * part testable without a Home Assistant, and keeps timestamps out of it —
 * comparing them would mean reconciling the container's UTC clock with HA's
 * local one, which is exactly the class of bug lib/ha-time.cjs exists to avoid.
 */

/** Journal lines are ANSI-coloured; ha-logs.sh strips the same sequences. */
function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

function toLines(text) {
  return stripAnsi(text).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l !== '');
}

/**
 * The lines `after` has that `before` did not — i.e. what was written while the
 * operation ran.
 *
 * Anchored on content, not time: find where `before` ends inside `after` and
 * take the rest. A multi-line anchor rather than a single line, because a log
 * repeats itself and a lone matching line can be the wrong one.
 *
 * Returns { lines, overlapped }. `overlapped: false` means the log moved on by
 * more than the window fetched, so the answer is a best-effort set difference
 * and the caller should say so rather than present it as complete.
 */
function newLines(before, after) {
  const prev = toLines(before);
  const next = toLines(after);
  if (!prev.length) return { lines: next, overlapped: true };

  for (let len = Math.min(5, prev.length); len >= 1; len--) {
    const anchor = prev.slice(prev.length - len);
    for (let i = next.length - anchor.length; i >= 0; i--) {
      if (anchor.every((line, k) => next[i + k] === line)) {
        return { lines: next.slice(i + anchor.length), overlapped: true };
      }
    }
  }

  const seen = new Set(prev);
  return { lines: next.filter((l) => !seen.has(l)), overlapped: false };
}

/*
 * The shapes HA uses to report a config it will not load an entity from. The
 * first is current (2024.x onwards); the others still appear from older
 * integrations and from setup failures, and cost nothing to keep matching.
 */
const PATTERNS = [
  {
    // Invalid config for 'template' at templates/blind.yaml, line 21: <message>
    re: /Invalid config for '([^']+)' at ([^,]+), line (\d+):\s*(.*)$/,
    map: (m) => ({ domain: m[1], file: m[2], line: Number(m[3]), message: m[4] }),
  },
  {
    // Invalid config for 'template' at templates/blind.yaml: <message>
    re: /Invalid config for '([^']+)' at ([^:]+):\s*(.*)$/,
    map: (m) => ({ domain: m[1], file: m[2], line: null, message: m[3] }),
  },
  {
    // Invalid config for [template]: <message>   (older, no file or line)
    re: /Invalid config for \[([^\]]+)\]:\s*(.*)$/,
    map: (m) => ({ domain: m[1], file: null, line: null, message: m[2] }),
  },
  {
    // Setup failed for 'template': <message>
    re: /Setup failed for '?([\w.]+)'?:\s*(.*)$/,
    map: (m) => ({ domain: m[1], file: null, line: null, message: m[2] }),
  },
  {
    // Platform error: sensor - <message>
    re: /Platform error:?\s+([\w.]+)\s+-\s+(.*)$/,
    map: (m) => ({ domain: m[1], file: null, line: null, message: m[2] }),
  },
];

/**
 * Turn log lines into the per-entity config errors they report.
 *
 * A voluptuous error wraps, so a line without its own timestamp is treated as a
 * continuation of the message above it. Duplicates are collapsed: HA reports the
 * same problem once per integration setup pass.
 */
function parseConfigErrors(lines) {
  const list = Array.isArray(lines) ? lines : toLines(lines);
  const found = [];
  let current = null;

  for (const line of list) {
    let matched = null;
    for (const { re, map } of PATTERNS) {
      const m = line.match(re);
      if (m) { matched = map(m); break; }
    }

    if (matched) {
      matched.message = matched.message.trim();
      found.push(matched);
      current = matched;
      continue;
    }

    if (current && !TIMESTAMPED.test(line)) {
      current.message = `${current.message} ${line.trim()}`.trim();
      continue;
    }
    if (TIMESTAMPED.test(line)) current = null;
  }

  const seen = new Set();
  return found.filter((e) => {
    const key = `${e.domain}|${e.file}|${e.line}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { stripAnsi, newLines, parseConfigErrors };
