/*
 * The pure halves of permissions and dialogs: what the Always button says, what
 * the /addon_configs guard matches, and how an answer is worded for the model.
 *
 * These modules read their configuration from the environment at import time, so
 * the /addon_configs cases are covered end-to-end in the integration suite (one
 * server per configuration). What is here is what does not depend on it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeSuggestions, addonConfigsDenyHook } from '../../server/lib/permissions.js';
import { formatQuestionDenial } from '../../server/lib/dialogs.js';

describe('describeSuggestions', () => {
  test('renders a rule as the user will see it on the Always button', () => {
    assert.equal(
      describeSuggestions([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }] }]),
      'Bash(git status:*)');
  });

  test('renders a whole-tool rule as just the tool name', () => {
    assert.equal(describeSuggestions([{ type: 'addRules', rules: [{ toolName: 'Read' }] }]), 'Read');
  });

  test('describes a mode change', () => {
    assert.equal(describeSuggestions([{ type: 'setMode', mode: 'acceptEdits' }]), 'mode: acceptEdits');
  });

  test('de-duplicates, so the label does not repeat itself', () => {
    assert.equal(describeSuggestions([
      { type: 'addRules', rules: [{ toolName: 'Read' }] },
      { type: 'replaceRules', rules: [{ toolName: 'Read' }] },
    ]), 'Read');
  });

  test('is empty when there is nothing to offer, which hides the button', () => {
    assert.equal(describeSuggestions([]), '');
    assert.equal(describeSuggestions(undefined), '');
    assert.equal(describeSuggestions([{ type: 'somethingNew' }]), '');
  });
});

describe('the /addon_configs guard', () => {
  const allows = (input) => addonConfigsDenyHook({ tool_input: input }).hookSpecificOutput === undefined;

  test('ignores a call that never names the mount', () => {
    assert.equal(allows({ file_path: '/config/configuration.yaml' }), true);
    assert.equal(allows({ command: 'ls /config' }), true);
  });

  test('catches the path wherever it appears in the input', () => {
    assert.equal(allows({ file_path: '/addon_configs/core_mosquitto/acl' }), false);
    assert.equal(allows({ path: '/addon_configs' }), false);
    assert.equal(allows({ command: 'cat /addon_configs/x/y' }), false);
    assert.equal(allows({ nested: { deep: ['/addon_configs/x'] } }), false);
  });

  test('explains how to turn access on rather than just refusing', () => {
    const out = addonConfigsDenyHook({ tool_input: { file_path: '/addon_configs/x' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Allow access to other app configs/);
  });

  test('always continues — the decision is the deny, not stopping the hook chain', () => {
    assert.equal(addonConfigsDenyHook({ tool_input: { file_path: '/addon_configs/x' } }).continue, true);
    assert.equal(addonConfigsDenyHook({ tool_input: {} }).continue, true);
  });

  test('tolerates a missing tool_input', () => {
    assert.equal(allows(undefined), true);
  });
});

describe('formatQuestionDenial', () => {
  const input = { questions: [{ header: 'Room' }, { header: 'Time' }] };

  test('is a deny, because that is the only shape that reaches the model', () => {
    assert.equal(formatQuestionDenial(input, { answers: { Room: 'Hall' } }).behavior, 'deny');
  });

  test('lists one line per question, in the order they were asked', () => {
    const { message } = formatQuestionDenial(input, { answers: { Room: 'Hall', Time: '7pm' } });
    assert.equal(message, 'The user answered your question(s):\n- Room: Hall\n- Time: 7pm');
  });

  test('joins a multi-select answer', () => {
    const { message } = formatQuestionDenial(
      { questions: [{ header: 'Rooms' }] }, { answers: { Rooms: ['Hall', 'Kitchen'] } });
    assert.match(message, /- Rooms: Hall, Kitchen/);
  });

  test('says so when a question was left blank, rather than printing undefined', () => {
    const { message } = formatQuestionDenial(input, { answers: { Room: 'Hall' } });
    assert.match(message, /- Time: \(no answer given\)/);
  });

  test('tells the model to carry on when the dialog was dismissed', () => {
    for (const result of [null, undefined, {}]) {
      const { message } = formatQuestionDenial(input, result);
      assert.match(message, /closed the question dialog without answering/);
      assert.match(message, /best judgement/);
    }
  });
});
