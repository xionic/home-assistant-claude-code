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
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5-1': 'Mythos 5.1',
  'claude-mythos-5': 'Mythos 5',
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

// Rebuild the dropdown from the SDK's own model catalog (query.supportedModels(),
// account-filtered — the same list Claude Code's /model picker uses), so the
// options track whatever the CLI currently offers instead of a hand-maintained
// list that goes stale. The static options in index.html are only the fallback
// shown before the first turn of a session.
export function applyModelCatalog(models) {
  if (!Array.isArray(models) || !models.length) return;
  const prevValue = modelSelect.value;
  const stored = localStorage.getItem('model');

  modelSelect.textContent = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.displayName || MODEL_LABELS[m.value] || m.value;
    if (m.description) opt.title = m.description;
    if (m.resolvedModel) opt.dataset.resolvedModel = m.resolvedModel;
    modelSelect.appendChild(opt);
  }

  const hasValue = (id) => [...modelSelect.options].some((o) => o.value === id);
  const rowForResolved = (id) => [...modelSelect.options].find((o) => o.dataset.resolvedModel === id);

  if (stored && hasValue(stored)) {
    modelSelect.value = stored;
  } else if (stored && rowForResolved(stored)) {
    modelSelect.value = rowForResolved(stored).value;
  } else if (stored) {
    ensureModelOption(stored);
    modelSelect.value = stored;
  } else if (hasValue(prevValue)) {
    modelSelect.value = prevValue;
  }
}
