/*
 * ha-time — one clock for all of ha-tools.
 *
 * Home Assistant hands out three different time formats depending on which API
 * you ask: epoch floats (history), UTC ISO strings (state attributes), and
 * local time (templates, via `now()`). Doing arithmetic across two of them is
 * how timestamps get quietly misreported, so every ha-tools command that prints
 * a time formats it here instead.
 *
 * The container's own clock is UTC — it does NOT inherit the timezone you set
 * in Home Assistant. So "local" here means *HA's* configured time_zone, fetched
 * from the running instance (`get_config`), not the container's idea of local.
 * `--utc` opts out.
 */

/** Parse `30s` / `10m` / `12h` / `2d`, or a bare number of seconds, into ms. */
function parseDuration(value, label = '--timeout') {
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!m) throw new Error(`invalid ${label}: ${value} (expected e.g. 30s, 10m, 12h)`);
  const scale = { s: 1000, m: 60000, h: 3600000, d: 86400000, '': 1000 };
  return parseFloat(m[1]) * scale[m[2]];
}

/** Parse `22:00-07:00` into minutes-past-midnight bounds. Windows may wrap. */
function parseWindow(value) {
  const m = String(value).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`invalid --between: ${value} (expected HH:MM-HH:MM)`);
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return { start, end, wraps: start > end };
}

/**
 * A formatter fixed to one IANA zone. Everything downstream asks this for
 * strings and for the wall-clock fields, so a timeline row and the --between
 * filter can never disagree about what hour an event happened in.
 */
function clock(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  });

  function fields(ms) {
    const parts = {};
    for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
    // longOffset renders as "GMT+01:00", or bare "GMT" at zero offset.
    const offset = (parts.timeZoneName || '').replace(/^GMT/, '') || '+00:00';
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      // Intl uses "24" for midnight in some locales; normalise it.
      hour: parts.hour === '24' ? '00' : parts.hour,
      minute: parts.minute,
      second: parts.second,
      offset,
    };
  }

  return {
    timeZone,
    /** "2026-08-12 23:27:42+01:00" — unambiguous, sortable, human-readable. */
    stamp(ms) {
      const f = fields(ms);
      return `${f.date} ${f.hour}:${f.minute}:${f.second}${f.offset}`;
    },
    /** Same instant, without the date — for compact timeline rows. */
    shortStamp(ms) {
      const f = fields(ms);
      return `${f.date.slice(5)} ${f.hour}:${f.minute}:${f.second}`;
    },
    /** Minutes past midnight in this zone, for --between filtering. */
    minutesOfDay(ms) {
      const f = fields(ms);
      return Number(f.hour) * 60 + Number(f.minute);
    },
    offset(ms) {
      return fields(ms).offset;
    },
  };
}

/** True when an instant falls inside a (possibly wrapping) HH:MM window. */
function inWindow(clockRef, ms, window) {
  if (!window) return true;
  const t = clockRef.minutesOfDay(ms);
  return window.wraps ? t >= window.start || t < window.end : t >= window.start && t < window.end;
}

/**
 * Coerce any timestamp Home Assistant might hand back — epoch seconds (history's
 * `lu`/`lc`), epoch milliseconds, or an ISO string — into epoch ms.
 */
function toMillis(value) {
  if (typeof value === 'number') {
    // History uses epoch *seconds* as a float; anything past ~2001 in seconds is
    // still under 1e12, which is where millisecond timestamps start.
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return isNaN(parsed) ? null : parsed;
}

module.exports = { parseDuration, parseWindow, clock, inWindow, toMillis };
