/*
 * Reading the errors Home Assistant logs about itself.
 *
 * The strings here are verbatim from a real instance (Core 2026.8.1) — the case
 * that started this: `config-check` answered "valid" for a template cover using
 * the legacy `position_template:` key, while HA logged the exact file, line and
 * key during that same check.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { stripAnsi, newLines, parseConfigErrors } = require(
  path.join(HERE, '..', '..', 'scripts', 'lib', 'ha-log-scan.cjs'));

const INVALID = "2026-08-25 01:15:42.123 ERROR (MainThread) [homeassistant.config] "
  + "Invalid config for 'template' at templates/nick_blind.yaml, line 21: "
  + "'position_template' is an invalid option for 'template', check: cover->0->position_template";

describe('parseConfigErrors', () => {
  test('names the file, line and key of a dropped entity', () => {
    const [e] = parseConfigErrors([INVALID]);
    assert.equal(e.domain, 'template');
    assert.equal(e.file, 'templates/nick_blind.yaml');
    assert.equal(e.line, 21);
    assert.match(e.message, /'position_template' is an invalid option/);
  });

  test('reads the older bracketed form, which carries no file or line', () => {
    const [e] = parseConfigErrors([
      '2026-08-25 01:15:42.123 ERROR (MainThread) [homeassistant.config] '
      + 'Invalid config for [automation]: required key not provided @ data["action"]',
    ]);
    assert.equal(e.domain, 'automation');
    assert.equal(e.file, null);
    assert.equal(e.line, null);
    assert.match(e.message, /required key not provided/);
  });

  test('picks up a setup failure and a platform error', () => {
    const found = parseConfigErrors([
      "2026-08-25 01:15:43.000 ERROR (MainThread) [homeassistant.setup] Setup failed for 'template': Invalid config.",
      '2026-08-25 01:15:44.000 ERROR (MainThread) [homeassistant.components.sensor] Platform error: sensor - bad schema',
    ]);
    assert.deepEqual(found.map((e) => e.domain), ['template', 'sensor']);
  });

  test('a wrapped message is one error, not two', () => {
    const found = parseConfigErrors([
      INVALID,
      "    extra keys not allowed @ data['cover'][0]['position_template']",
      '2026-08-25 01:15:45.000 INFO (MainThread) [homeassistant.core] Bus:Handling <Event x>',
    ]);
    assert.equal(found.length, 1);
    assert.match(found[0].message, /extra keys not allowed/);
  });

  test('an untimestamped line after an ordinary log line is not swept in', () => {
    const found = parseConfigErrors([
      '2026-08-25 01:15:45.000 INFO (MainThread) [homeassistant.core] Starting',
      '    some indented continuation of that INFO line',
    ]);
    assert.deepEqual(found, []);
  });

  test('the same problem reported twice is reported once', () => {
    assert.equal(parseConfigErrors([INVALID, INVALID]).length, 1);
  });

  test('a clean log yields nothing — the check must not cry wolf', () => {
    const found = parseConfigErrors([
      '2026-08-25 01:15:45.000 INFO (MainThread) [homeassistant.core] Bus:Handling <Event x>',
      '2026-08-25 01:15:46.000 WARNING (MainThread) [homeassistant.helpers] Something slow',
    ]);
    assert.deepEqual(found, []);
  });
});

describe('newLines', () => {
  const before = ['a', 'b', 'c'].join('\n');

  test('returns only what was written after the snapshot', () => {
    const { lines, overlapped } = newLines(before, ['a', 'b', 'c', 'd', 'e'].join('\n'));
    assert.deepEqual(lines, ['d', 'e']);
    assert.equal(overlapped, true);
  });

  test('nothing new is an empty list, not the whole log', () => {
    assert.deepEqual(newLines(before, before).lines, []);
  });

  test('anchors on a block, so a repeated line does not misplace the boundary', () => {
    // 'c' appears twice; a single-line anchor would take the later one and lose
    // the two lines in between.
    const after = ['a', 'b', 'c', 'x', 'c', 'y'].join('\n');
    assert.deepEqual(newLines(after, [...after.split('\n'), 'z'].join('\n')).lines, ['z']);
  });

  test('says so when the log rolled past the window it could see', () => {
    const { lines, overlapped } = newLines(before, ['q', 'r'].join('\n'));
    assert.equal(overlapped, false, 'a gap must be reported, not papered over');
    assert.deepEqual(lines, ['q', 'r']);
  });

  test('an empty prior snapshot means everything is new', () => {
    assert.deepEqual(newLines('', 'a\nb').lines, ['a', 'b']);
  });

  test('ANSI colouring does not make identical lines look different', () => {
    const coloured = '\x1b[31ma\x1b[0m\nb';
    assert.deepEqual(newLines(coloured, 'a\nb\nc').lines, ['c']);
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  });
});
