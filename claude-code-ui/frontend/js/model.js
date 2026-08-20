/*
 * The model dropdown and the context-usage meter (progress toward auto-compaction).
 */
import { S } from './state.js';
import { modelSelect } from './dom.js';

// ── Model dropdown ───────────────────────────────────────────────────────────
// The dropdown in index.html carries the current models; these labels also cover
// older ids so a stored choice — or a model the SDK reports back — still renders
// with a friendly name via ensureModelOption() instead of a raw id string.
export const MODEL_LABELS = {
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
};
// Real, cache-inclusive context-window S.usage reported by the SDK
// (query.getContextUsage), pushed after every turn. Drives the hint above the
// input showing progress toward auto-compaction.
export const ctxTokensEl = document.getElementById('ctx-tokens');

export function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function updateCtxHint() {
  ctxTokensEl.classList.remove('ctx-warn', 'ctx-danger');
  if (!S.ctxUsage || !S.ctxUsage.totalTokens) { ctxTokensEl.classList.add('hidden'); return; }
  const { totalTokens, maxTokens, autoCompactThreshold, autoCompactEnabled } = S.ctxUsage;
  const compact = autoCompactEnabled && autoCompactThreshold;
  const limit = compact ? autoCompactThreshold : maxTokens;
  let text = `${fmtTokens(totalTokens)} tokens`;
  let pct = 0;
  if (limit) {
    pct = Math.min(100, Math.round(totalTokens / limit * 100));
    text += compact ? ` · ${pct}% to auto-compact` : ` · ${pct}% of ${fmtTokens(maxTokens)}`;
  }
  // As the window fills, warn — and once nearly full, nudge toward /compact,
  // since that's the point where a chat can appear to stall while it compacts.
  if (pct >= 95) { text += ' · run /compact'; ctxTokensEl.classList.add('ctx-danger'); }
  else if (pct >= 80) ctxTokensEl.classList.add('ctx-warn');
  ctxTokensEl.textContent = text;
  ctxTokensEl.classList.remove('hidden');
}
export function ensureModelOption(id) {
  if ([...modelSelect.options].some((o) => o.value === id)) return;
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = MODEL_LABELS[id] || id;
  modelSelect.appendChild(opt);
}
