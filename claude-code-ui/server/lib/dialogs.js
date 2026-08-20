/*
 * AskUserQuestion.
 *
 * The SDK's own dialog transport (`onUserDialog`) is never actually reached for
 * this tool: the call completes inside the CLI subprocess with a canned "The
 * user did not answer the questions." and no request_user_dialog is ever sent,
 * whatever `toolConfig.askUserQuestion` declares. That is why the tool used to
 * be disallowed outright.
 *
 * It is driven by hand instead: intercept the call before it runs, put the
 * question to the browser, and turn whatever comes back into a *denial* whose
 * message is the user's answer. `canUseTool` has no "succeeded with this result"
 * shape, and a denial's message is what reaches the model as the tool result —
 * verified live: the model reads it as the answer and carries on normally.
 *
 * Pending questions are module-level, not per-connection: a question belongs to
 * the run, so any tab may answer it and a tab that connects later is shown the
 * one still waiting.
 */
import { randomUUID } from 'crypto';
import { broadcast } from './broadcast.js';

export const pendingDialogs = new Map();   // id → { payload, resolve }

export function formatQuestionDenial(toolInput, result) {
  if (!result || !result.answers) {
    return {
      behavior: 'deny',
      message: 'The user closed the question dialog without answering. Ask again if you still need the answer, ' +
        'or carry on using your best judgement.',
    };
  }
  const lines = (toolInput.questions || []).map((q) => {
    const a = result.answers[q.header];
    const text = Array.isArray(a) ? a.join(', ') : (a || '(no answer given)');
    return `- ${q.header}: ${text}`;
  });
  return { behavior: 'deny', message: `The user answered your question(s):\n${lines.join('\n')}` };
}

/**
 * Put a question to whoever is connected and wait — however long that takes.
 * Resolves with the raw answer payload, or null if it was skipped or aborted.
 *
 * Deliberately waits even with nobody connected right now (an unattended
 * auto-continue resume, or a phone mid-reconnect): broadcast() to zero clients
 * is a no-op, and a client that connects later is shown every entry still
 * pending. The question is just as answerable in ten minutes, or tomorrow, as it
 * was the instant it was asked. The only things that end the wait are an answer,
 * Skip, or the run itself ending.
 */
export function askQuestion(toolInput, signal) {
  return new Promise((resolve) => {
    const id = randomUUID();
    pendingDialogs.set(id, { payload: toolInput, resolve });
    broadcast({ type: 'user_dialog', id, dialogKind: 'askUserQuestion', payload: toolInput });
    signal?.addEventListener('abort', () => {
      if (pendingDialogs.delete(id)) {
        // Without telling the clients, the question would sit on screen as
        // still-waiting after Stop had already ended the turn.
        broadcast({ type: 'user_dialog_cancelled', id });
        resolve(null);
      }
    }, { once: true });
  });
}

/** Answer a pending question. Returns false if it is no longer waiting. */
export function answerDialog(id, result) {
  const entry = pendingDialogs.get(id);
  if (!entry) return false;
  pendingDialogs.delete(id);
  broadcast({ type: 'user_dialog_cancelled', id });   // close it on every other tab
  entry.resolve(result || null);
  return true;
}

/**
 * The `auto` permission mode is SDK-native and has no canUseTool, so the same
 * interception happens as a PreToolUse hook — which runs in every mode and
 * short-circuits the tool before it executes.
 */
export async function askQuestionHook(input, _toolUseID, options) {
  if (input?.tool_name !== 'AskUserQuestion') return { continue: true };
  const toolInput = input.tool_input || {};
  const answer = await askQuestion(toolInput, options?.signal);
  const denial = formatQuestionDenial(toolInput, answer);
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial.message,
    },
  };
}
