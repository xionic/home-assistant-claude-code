/*
 * Which slash commands a browser is offered.
 *
 * The failure to avoid is over-filtering: the SDK omits the tag entirely on
 * older CLIs and on sessions where nothing is terminal-bound, and reading that
 * absence as "hide everything" would empty the autocomplete.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { usableSlashCommands } from '../../server/lib/slash-commands.js';

describe('usableSlashCommands', () => {
  test('drops the commands the SDK tags as terminal-bound', () => {
    assert.deepEqual(
      usableSlashCommands({
        slash_commands: ['compact', 'exit', 'clear', 'statusline'],
        terminal_slash_commands: ['exit', 'statusline'],
      }),
      ['compact', 'clear']);
  });

  test('keeps everything when the tag is absent — an older CLI, not an empty menu', () => {
    assert.deepEqual(
      usableSlashCommands({ slash_commands: ['compact', 'clear'] }),
      ['compact', 'clear']);
  });

  test('keeps everything when the tag is present but empty', () => {
    assert.deepEqual(
      usableSlashCommands({ slash_commands: ['compact'], terminal_slash_commands: [] }),
      ['compact']);
  });

  test('preserves the order the SDK advertised', () => {
    assert.deepEqual(
      usableSlashCommands({
        slash_commands: ['a', 'exit', 'b', 'c'],
        terminal_slash_commands: ['exit'],
      }),
      ['a', 'b', 'c']);
  });

  test('tolerates a tag naming something not in the list', () => {
    assert.deepEqual(
      usableSlashCommands({ slash_commands: ['compact'], terminal_slash_commands: ['exit'] }),
      ['compact']);
  });

  test('distinguishes "no list at all" from "filtered down to nothing"', () => {
    assert.equal(usableSlashCommands({}), null);
    assert.equal(usableSlashCommands(undefined), null);
    assert.deepEqual(
      usableSlashCommands({ slash_commands: ['exit'], terminal_slash_commands: ['exit'] }),
      [], 'an empty array is a real answer; null means the event carried no list');
  });

  test('ignores a malformed tag rather than throwing mid-run', () => {
    assert.deepEqual(
      usableSlashCommands({ slash_commands: ['compact'], terminal_slash_commands: 'exit' }),
      ['compact']);
  });
});
