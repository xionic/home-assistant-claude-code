/*
 * Module-resolution hook that redirects @anthropic-ai/claude-agent-sdk to the
 * scripted stub. Runs on Node's loader thread, so it must not import anything
 * from the test process.
 */
const SDK = '@anthropic-ai/claude-agent-sdk';
const STUB = new URL('./stub-sdk.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === SDK) {
    return { url: STUB, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
