/*
 * Reading Claude Code's transcript format. The integration tests cover this
 * through the wire; these cover the edges it is impractical to script a whole
 * session for — and they localise a failure to the parser rather than the
 * server.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockText, isCommandEcho, isQuestionAnswer, lineToItems, truncateOutput,
} from '../../server/lib/sessions.js';

const at = '2026-07-15T09:30:00.000Z';
const ts = Date.parse(at);

describe('blockText', () => {
  test('passes a plain string through', () => {
    assert.equal(blockText('hello'), 'hello');
  });

  test('joins the text of a content-block array', () => {
    assert.equal(blockText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
    assert.equal(blockText(['a', 'b']), 'ab');
  });

  test('falls back to JSON for a shape it does not know', () => {
    assert.equal(blockText({ weird: true }), '{"weird":true}');
  });

  test('treats a block with no text as empty rather than "undefined"', () => {
    assert.equal(blockText([{ type: 'image' }]), '');
  });
});

describe('isCommandEcho', () => {
  test('recognises the slash-command plumbing the CLI records as user messages', () => {
    assert.equal(isCommandEcho('<command-name>/compact</command-name>'), true);
    assert.equal(isCommandEcho('<local-command-stdout>done</local-command-stdout>'), true);
  });

  test('leaves an ordinary message alone', () => {
    assert.equal(isCommandEcho('please compact the chat'), false);
    assert.equal(isCommandEcho(undefined), false);
  });
});

describe('isQuestionAnswer', () => {
  const answer = 'The user answered your question(s):\n- Room: Hall';
  const skipped = 'The user closed the question dialog without answering. Ask again…';

  test('is true for an AskUserQuestion result, which always arrives as an error', () => {
    assert.equal(isQuestionAnswer('AskUserQuestion', true, answer), true);
  });

  test('is false when the call did not fail — nothing to reinterpret', () => {
    assert.equal(isQuestionAnswer('AskUserQuestion', false, answer), false);
  });

  test('recognises both answer texts when the tool name has been truncated away', () => {
    assert.equal(isQuestionAnswer(undefined, true, answer), true);
    assert.equal(isQuestionAnswer(undefined, true, skipped), true);
  });

  test('does not reinterpret a genuine failure from another tool', () => {
    assert.equal(isQuestionAnswer('Bash', true, 'command not found'), false);
    assert.equal(isQuestionAnswer(undefined, true, 'command not found'), false);
  });

  test('only matches the answer text at the start, not mentioned in passing', () => {
    assert.equal(
      isQuestionAnswer(undefined, true, 'grep found: The user answered your question(s):'),
      false);
  });
});

describe('truncateOutput', () => {
  test('leaves a reasonable result alone', () => {
    assert.equal(truncateOutput('short'), 'short');
  });

  test('caps a flood and says that it did', () => {
    const out = truncateOutput('x'.repeat(10_000));
    assert.ok(out.length < 4100);
    assert.ok(out.endsWith('…[truncated]'));
  });
});

describe('lineToItems', () => {
  test('turns a user string into one item, stamped from the transcript', () => {
    const items = lineToItems({ type: 'user', timestamp: at, message: { content: 'hello' } });
    assert.deepEqual(items, [{ kind: 'user', text: 'hello', ts }]);
  });

  test('skips meta, sidechain and compact-summary lines', () => {
    for (const flag of ['isMeta', 'isSidechain', 'isCompactSummary']) {
      const items = lineToItems({ type: 'user', [flag]: true, message: { content: 'noise' } });
      assert.deepEqual(items, [], `${flag} was not skipped`);
    }
  });

  test('skips a line with no message at all', () => {
    assert.deepEqual(lineToItems({ type: 'user' }), []);
  });

  test('drops whitespace-only and slash-command user messages', () => {
    assert.deepEqual(lineToItems({ type: 'user', message: { content: '   ' } }), []);
    assert.deepEqual(lineToItems({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }), []);
  });

  test('carries tool names across the transcript so a result can be interpreted', () => {
    const toolNames = new Map();
    lineToItems({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] },
    }, toolNames);

    const [result] = lineToItems({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'q1', is_error: true, content: 'anything at all' }] },
    }, toolNames);

    assert.equal(result.answered, true, 'the name came from the earlier line');
    assert.equal(result.isError, false);
  });

  test('leaves a real tool failure as an error', () => {
    const toolNames = new Map([['b1', 'Bash']]);
    const [result] = lineToItems({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' }] },
    }, toolNames);
    assert.equal(result.isError, true);
    assert.equal(result.answered, false);
  });

  test('emits text and tool_use from one assistant message in order', () => {
    const items = lineToItems({
      type: 'assistant',
      timestamp: at,
      message: { content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/config/a' } },
      ] },
    });
    assert.deepEqual(items.map((i) => i.kind), ['text', 'tool_use']);
    assert.equal(items[1].name, 'Read');
    assert.equal(items[1].ts, ts);
  });

  test('omits ts entirely when the line has no usable timestamp', () => {
    const [item] = lineToItems({ type: 'user', timestamp: 'not a date', message: { content: 'hi' } });
    assert.equal('ts' in item, false, 'an undefined ts would render as a bogus date');
  });

  test('ignores a line type it does not know', () => {
    assert.deepEqual(lineToItems({ type: 'system', message: { content: 'x' } }), []);
  });
});
