/*
 * stub-sdk — a scripted stand-in for `query()` from @anthropic-ai/claude-agent-sdk.
 *
 * The server is booted with `--import test/helpers/sdk-loader.mjs`, which
 * redirects the SDK specifier here. Production code is not modified to
 * accommodate this: from server/index.js's point of view it imported the real
 * package.
 *
 * A run is scripted as JSON (path in $STUB_SDK_SCENARIO). Each call to query()
 * consumes the next entry of `runs`; once they are exhausted a trivial
 * init → result run is replayed, so a test only has to script the turns it
 * actually cares about.
 *
 *   { "runs": [ { "steps": [ … ] } ] }
 *
 * Step kinds:
 *   { "text": "hello" }                  assistant text block
 *   { "emit": { …raw SDK event… } }      yielded verbatim
 *   { "tool": { name, input, id?,        full tool lifecycle: assistant tool_use,
 *               output?, isError? } }    then hooks → canUseTool, then the
 *                                        tool_result the decision implies
 *   { "hook": { tool_name, tool_input } } run PreToolUse hooks only
 *   { "contextUsage": { … } }            what the next getContextUsage() returns
 *   { "sleep": 250 }
 *   { "throw": "message" }               generator throws (post-result throws included)
 *
 * `{{SESSION_ID}}` anywhere in an emitted event is replaced with the run's
 * session id, so a scripted `result`/`init` matches what the server resumed.
 *
 * Everything the server hands the SDK, and every decision the SDK gets back, is
 * appended as JSONL to $STUB_SDK_RECORD — that is how tests assert on the
 * options the server built (suggestions, permissionMode, hooks, resume …)
 * without reaching into its internals.
 */
import { appendFileSync, readFileSync } from 'fs';

const SCENARIO_FILE = process.env.STUB_SDK_SCENARIO || '';
const RECORD_FILE = process.env.STUB_SDK_RECORD || '';

let scenario = { runs: [] };
if (SCENARIO_FILE) {
  try { scenario = JSON.parse(readFileSync(SCENARIO_FILE, 'utf8')); }
  catch (e) { console.error(`[stub-sdk] could not read scenario: ${e.message}`); }
}

let runIndex = 0;
let sessionCounter = 0;

function record(entry) {
  if (!RECORD_FILE) return;
  try { appendFileSync(RECORD_FILE, JSON.stringify(entry) + '\n'); } catch {}
}

/** Options are full of functions and AbortControllers — keep only what asserts. */
function describeOptions(options = {}) {
  return {
    cwd: options.cwd,
    model: options.model ?? null,
    effort: options.effort ?? null,
    permissionMode: options.permissionMode ?? null,
    resume: options.resume ?? null,
    hasCanUseTool: typeof options.canUseTool === 'function',
    preToolUseHooks: (options.hooks?.PreToolUse || []).reduce((n, m) => n + (m.hooks?.length || 0), 0),
    supportedDialogKinds: options.supportedDialogKinds ?? null,
    toolConfig: options.toolConfig ?? null,
    plugins: (options.plugins || []).map((p) => p.path),
  };
}

function substitute(value, sessionId) {
  if (typeof value === 'string') return value.replaceAll('{{SESSION_ID}}', sessionId);
  if (Array.isArray(value)) return value.map((v) => substitute(v, sessionId));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, sessionId);
    return out;
  }
  return value;
}

/** Run every PreToolUse hook, returning the first deny (matching SDK precedence). */
async function runPreToolUseHooks(options, toolName, toolInput, toolUseID, signal) {
  const matchers = options.hooks?.PreToolUse || [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks || []) {
      const out = await hook({ tool_name: toolName, tool_input: toolInput }, toolUseID, { signal });
      const spec = out?.hookSpecificOutput;
      if (spec?.permissionDecision === 'deny') {
        return { denied: true, reason: spec.permissionDecisionReason };
      }
      if (spec?.permissionDecision === 'allow') return { denied: false, allowed: true };
    }
  }
  return { denied: false };
}

export function query({ prompt, options = {} }) {
  const run = scenario.runs?.[runIndex] || { steps: [{ text: 'ok' }] };
  runIndex += 1;

  // Resuming keeps the session id; a fresh run mints one, as the CLI does.
  const sessionId = options.resume || `stub-session-${++sessionCounter}`;
  record({ kind: 'query', prompt, options: describeOptions(options), sessionId });

  let contextUsage = {
    totalTokens: 1000, maxTokens: 200000,
    autoCompactThreshold: 160000, isAutoCompactEnabled: true,
  };

  const signal = options.abortController?.signal;

  async function* generate() {
    // Every real run opens with system/init; scripts never have to say so.
    yield {
      type: 'system', subtype: 'init', session_id: sessionId,
      model: options.model || 'claude-opus-5',
      slash_commands: ['compact', 'clear'],
      mcp_servers: [],
    };

    for (const step of run.steps || []) {
      if (signal?.aborted) return;

      if (step.sleep) {
        await new Promise((r) => setTimeout(r, step.sleep));

      } else if (step.throw) {
        throw new Error(step.throw);

      } else if (step.contextUsage) {
        contextUsage = { ...contextUsage, ...step.contextUsage };

      } else if (step.text != null) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: step.text }] } };

      } else if (step.emit) {
        yield substitute(step.emit, sessionId);

      } else if (step.hook) {
        const r = await runPreToolUseHooks(options, step.hook.tool_name, step.hook.tool_input, 'hook-only', signal);
        record({ kind: 'hook', tool: step.hook.tool_name, result: r });

      } else if (step.tool) {
        const t = step.tool;
        const id = t.id || `toolu_${Math.random().toString(36).slice(2, 10)}`;
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: t.name, input: t.input || {} }] } };

        // Hooks first — a deny short-circuits the tool before canUseTool, which
        // is exactly why the /addon_configs guard is a hook and not canUseTool.
        const hookResult = await runPreToolUseHooks(options, t.name, t.input || {}, id, signal);
        let outcome;
        if (hookResult.denied) {
          outcome = { behavior: 'deny', message: hookResult.reason, via: 'hook' };
        } else if (typeof options.canUseTool === 'function') {
          const decision = await options.canUseTool(t.name, t.input || {}, {
            signal: signal || new AbortController().signal,
            suggestions: t.suggestions || [],
            title: t.title,
            description: t.description,
          });
          outcome = { ...decision, via: 'canUseTool' };
        } else {
          outcome = { behavior: 'allow', via: 'none' };
        }
        record({ kind: 'tool_decision', tool: t.name, id, outcome });

        const denied = outcome.behavior === 'deny';
        const output = denied ? (outcome.message || 'Denied') : (t.output ?? `${t.name} ran`);
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: denied || !!t.isError }] },
        };
      }
    }

    // …and every real run closes with a result, unless the script threw first.
    if (run.noResult) return;
    yield {
      type: 'result', subtype: run.resultSubtype || 'success',
      total_cost_usd: 0.01, num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    // A usage-limit rejection can throw *after* claiming success — the case the
    // server has to see through. `throwAfterResult` reproduces it.
    if (run.throwAfterResult) throw new Error(run.throwAfterResult);
  }

  const iterator = generate();
  return {
    [Symbol.asyncIterator]() { return this; },
    next: (...a) => iterator.next(...a),
    return: (...a) => iterator.return(...a),
    throw: (...a) => iterator.throw(...a),
    getContextUsage: async () => contextUsage,
  };
}

export default { query };
