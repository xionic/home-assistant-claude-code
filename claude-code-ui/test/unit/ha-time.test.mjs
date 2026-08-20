/*
 * lib/ha-time — the one clock all of ha-tools formats through.
 *
 * Home Assistant hands out three different time formats depending on which API
 * you ask (epoch-second floats from history, UTC ISO from state attributes,
 * local from templates), and the container clock is UTC regardless of what the
 * user set in HA. Every quiet misreporting bug lives in that gap.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { parseDuration, parseWindow, clock, inWindow, toMillis } =
  require(path.join(APP_ROOT, 'scripts', 'lib', 'ha-time.cjs'));

describe('parseDuration', () => {
  test('understands the suffixes the tools document', () => {
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('10m'), 600_000);
    assert.equal(parseDuration('12h'), 43_200_000);
    assert.equal(parseDuration('2d'), 172_800_000);
  });

  test('treats a bare number as seconds', () => {
    assert.equal(parseDuration('45'), 45_000);
    assert.equal(parseDuration('1.5'), 1500);
  });

  test('rejects anything else rather than guessing', () => {
    for (const bad of ['10x', 'soon', '', '5 m', '-3s']) {
      assert.throws(() => parseDuration(bad, '--timeout'), /invalid --timeout/, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseWindow', () => {
  test('parses HH:MM-HH:MM into minutes past midnight', () => {
    assert.deepEqual(parseWindow('09:30-17:00'), { start: 570, end: 1020, wraps: false });
  });

  test('marks a window that runs past midnight as wrapping', () => {
    assert.deepEqual(parseWindow('22:00-07:00'), { start: 1320, end: 420, wraps: true });
  });

  test('tolerates a single-digit hour and surrounding spaces', () => {
    assert.deepEqual(parseWindow('9:00 - 17:00'), { start: 540, end: 1020, wraps: false });
  });

  test('rejects a malformed window', () => {
    for (const bad of ['9-17', '22:00', '22:00-', 'evening']) {
      assert.throws(() => parseWindow(bad), /invalid --between/, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe('toMillis', () => {
  const ms = Date.UTC(2026, 6, 15, 9, 30, 0);

  test('accepts epoch seconds as a float, which is what history returns', () => {
    assert.equal(toMillis(ms / 1000), ms);
    assert.equal(toMillis(ms / 1000 + 0.5), ms + 500);
  });

  test('leaves epoch milliseconds alone', () => {
    assert.equal(toMillis(ms), ms);
  });

  test('parses the ISO strings state attributes use', () => {
    assert.equal(toMillis('2026-07-15T09:30:00+00:00'), ms);
    assert.equal(toMillis('2026-07-15T10:30:00+01:00'), ms, 'the same instant, stated differently');
  });

  test('returns null for something unparseable rather than NaN', () => {
    assert.equal(toMillis('not a time'), null);
  });

  test('puts the seconds/milliseconds boundary past any plausible recent date', () => {
    // 1e12 ms is 2001; 1e12 s would be the year 33658. Anything below the
    // boundary is therefore seconds, and this is the assumption that decides it.
    assert.equal(toMillis(999_999_999_999), 999_999_999_999_000);
    assert.equal(toMillis(1_000_000_000_000), 1_000_000_000_000);
  });
});

describe('clock', () => {
  const winter = Date.UTC(2026, 0, 15, 9, 30, 0);   // GMT
  const summer = Date.UTC(2026, 6, 15, 9, 30, 0);   // BST

  test('stamps with an explicit offset, so a time is never ambiguous', () => {
    const c = clock('Europe/London');
    assert.equal(c.stamp(winter), '2026-01-15 09:30:00+00:00');
    assert.equal(c.stamp(summer), '2026-07-15 10:30:00+01:00');
  });

  test('shows a zero offset as +00:00, not a bare "GMT"', () => {
    assert.equal(clock('UTC').stamp(winter), '2026-01-15 09:30:00+00:00');
    assert.equal(clock('Europe/London').offset(winter), '+00:00');
  });

  test('handles a negative offset and a half-hour one', () => {
    assert.equal(clock('America/New_York').stamp(winter), '2026-01-15 04:30:00-05:00');
    assert.equal(clock('Asia/Kolkata').stamp(winter), '2026-01-15 15:00:00+05:30');
  });

  test('normalises the hour Intl reports as 24 at midnight', () => {
    const c = clock('Europe/London');
    const midnight = Date.UTC(2026, 0, 15, 0, 0, 0);
    assert.equal(c.stamp(midnight), '2026-01-15 00:00:00+00:00');
    assert.equal(c.minutesOfDay(midnight), 0);
  });

  test('minutesOfDay is in the same zone the rows print in', () => {
    // 09:30 UTC is 10:30 in London during BST — a --between filter working off
    // the container's UTC clock would silently be an hour out.
    assert.equal(clock('Europe/London').minutesOfDay(summer), 10 * 60 + 30);
    assert.equal(clock('UTC').minutesOfDay(summer), 9 * 60 + 30);
  });
});

describe('inWindow', () => {
  const c = clock('UTC');
  const at = (h, m = 0) => Date.UTC(2026, 0, 15, h, m, 0);

  test('is inclusive of the start and exclusive of the end', () => {
    const w = parseWindow('09:00-17:00');
    assert.equal(inWindow(c, at(9), w), true);
    assert.equal(inWindow(c, at(16, 59), w), true);
    assert.equal(inWindow(c, at(17), w), false);
    assert.equal(inWindow(c, at(8, 59), w), false);
  });

  test('a wrapping window covers both sides of midnight', () => {
    const w = parseWindow('22:00-07:00');
    assert.equal(inWindow(c, at(23), w), true);
    assert.equal(inWindow(c, at(3), w), true);
    assert.equal(inWindow(c, at(12), w), false);
  });

  test('no window means everything passes', () => {
    assert.equal(inWindow(c, at(12), null), true);
  });
});
