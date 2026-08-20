/*
 * Building the transcript: user bubbles, assistant text, tool calls and their
 * results, and rebuilding the whole thing from stored history on reconnect.
 */
import { S } from './state.js';
import { clearScreen } from './commands.js';
import { messagesEl } from './dom.js';
import { addCopyButton, renderMarkdown } from './links.js';
import { scrollBottom } from './scroll.js';

// ── Message rendering ──────────────────────────────────────────────────────

// Compact HH:MM timestamp shown on each message. `ts` (epoch ms) comes from the
// stored transcript on reload; live messages pass nothing and get stamped now.
// Tool call elements by id, so a result can be attached to the call it came
// from — a tool_result event carries only the id.
export const toolCallEls = new Map();

export function fmtTime(ms) {
  const d = ms ? new Date(ms) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function addTime(bubble, ts) {
  const t = document.createElement('span');
  t.className = 'msg-time';
  t.textContent = fmtTime(ts);
  t.title = (ts ? new Date(ts) : new Date()).toLocaleString();
  bubble.appendChild(t);
}

export function appendUserBubble(text, ts, atts) {
  S.lastAssistantBubble = null;
  endToolGroup();
  const div = mkBubble('user');
  const content = div.querySelector('.bubble-content');
  // Attachment thumbnails/chips (live send only) above the text.
  if (atts && atts.length) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-attachments';
    for (const a of atts) {
      if (a.isImage && a.dataUrl) {
        const img = document.createElement('img');
        img.className = 'bubble-attach-img'; img.src = a.dataUrl; img.alt = a.name;
        wrap.appendChild(img);
      } else {
        const chip = document.createElement('span');
        chip.className = 'bubble-attach-file'; chip.textContent = '📎 ' + a.name;
        wrap.appendChild(chip);
      }
    }
    content.appendChild(wrap);
  }
  if (text) {
    const t = document.createElement('div');
    t.textContent = text;
    content.appendChild(t);
  }
  addTime(div, ts);
  messagesEl.appendChild(div);
  scrollBottom();
}

export function appendAssistantText(text, ts) {
  if (!S.lastAssistantBubble) {
    endToolGroup();
    S.lastAssistantBubble = mkBubble('assistant');
    addTime(S.lastAssistantBubble, ts);
    messagesEl.appendChild(S.lastAssistantBubble);
  }
  const content = S.lastAssistantBubble.querySelector('.bubble-content');
  content._rawMd = (content._rawMd || '') + text;
  renderMarkdown(content, content._rawMd);
  scrollBottom();
}

export function appendToolUse(id, name, input) {
  const el = document.createElement('div');
  el.className = 'tool-call';

  const header = document.createElement('div');
  header.className = 'tool-call-header';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = '⚙';

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-call-name';
  nameEl.textContent = name;

  const summaryEl = document.createElement('span');
  summaryEl.className = 'tool-call-summary';
  summaryEl.textContent = getInputSummary(name, input);

  const statusEl = document.createElement('span');
  statusEl.className = 'tool-call-status status-running';

  const chevron = document.createElement('span');
  chevron.className = 'tool-call-chevron';
  chevron.textContent = '▾';

  header.append(icon, nameEl, summaryEl, statusEl, chevron);

  const body = document.createElement('div');
  body.className = 'tool-call-body';
  body.appendChild(renderToolInput(name, input));

  el.append(header, body);
  header.onclick = () => el.classList.toggle('expanded');

  const group = ensureToolGroup();
  const st = group._st;
  st.count++;
  st.running.add(el);
  if (st.names[st.names.length - 1] !== name) st.names.push(name);
  group.querySelector('.tool-group-body').appendChild(el);
  refreshToolGroup(group);

  scrollBottom();

  toolCallEls.set(id, el);
}

// A tool call's input, rendered as something readable where the shape is known.
// A question is the case that matters most: {questions:[…]} as raw JSON is
// unreadable, and it's the one tool call whose input is addressed to a person.
export function renderToolInput(name, input) {
  if (name === 'AskUserQuestion' && Array.isArray(input && input.questions)) {
    const wrap = document.createElement('div');
    wrap.className = 'tool-call-questions';
    for (const q of input.questions) {
      const h = document.createElement('div');
      h.className = 'tool-call-q';
      h.textContent = q.question || q.header || '';
      wrap.appendChild(h);
      if (Array.isArray(q.options) && q.options.length) {
        const ul = document.createElement('ul');
        ul.className = 'tool-call-q-opts';
        for (const o of q.options) {
          const li = document.createElement('li');
          li.textContent = (o && o.label) || String(o);
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      }
    }
    return wrap;
  }
  const pre = document.createElement('pre');
  pre.className = 'tool-call-input';
  const raw = JSON.stringify(input || {}, null, 2);
  pre.textContent = raw.length > 600 ? raw.slice(0, 600) + '\n…' : raw;
  addCopyButton(pre);
  return pre;
}

// ── Runs of tool calls ───────────────────────────────────────────────────────
// A turn is often twenty Reads and Bashes in a row, which buries the prose on
// either side of it. Adjacent calls collapse into a single row — and they do it
// *as they arrive*, not once the turn ends: a run only folded away at the end
// meant watching the transcript unfurl into a wall of tool calls first, which is
// exactly the mess the folding exists to prevent.
//
// Nothing is hidden that you were actually watching: the folded header names the
// call that's running right now, and afterwards which tools ran and whether any
// failed. Clicking it opens the run — and once you've done that, later calls
// joining the run must not fold it back up under you (`_touched`).
export function ensureToolGroup() {
  if (S.currentToolGroup) return S.currentToolGroup;
  const group = document.createElement('div');
  group.className = 'tool-group';
  group._st = { count: 0, failed: 0, running: new Set(), names: [], touched: false };

  const gh = document.createElement('div');
  gh.className = 'tool-group-header hidden';
  gh.innerHTML =
    '<span class="tool-group-icon">⚙</span>' +
    '<span class="tool-group-count"></span>' +
    '<span class="tool-group-summary"></span>' +
    '<span class="tool-group-chevron">▾</span>';
  gh.onclick = () => {
    group._st.touched = true;
    group.classList.toggle('collapsed');
  };

  const body = document.createElement('div');
  body.className = 'tool-group-body';

  group.append(gh, body);
  messagesEl.appendChild(group);
  S.currentToolGroup = group;
  return group;
}

// What a folded run says about itself: while something is running, the call
// still going; once it's done, which tools ran. Consecutive repeats collapse to
// one entry — six Reads in a row reads "Read", not "Read · Read · Read · …".
export function groupSummary(st) {
  const running = [...st.running].pop();
  if (running) {
    const name = (running.querySelector('.tool-call-name') || {}).textContent || '';
    const arg = (running.querySelector('.tool-call-summary') || {}).textContent || '';
    return arg ? `${name} ${arg}` : name;
  }
  return st.names.length > 6
    ? `${st.names.slice(0, 6).join(' · ')} +${st.names.length - 6}`
    : st.names.join(' · ');
}

export function refreshToolGroup(group) {
  const st = group && group._st;
  if (!st) return;
  const gh = group.querySelector('.tool-group-header');

  // One call speaks for itself; the group only takes over once there's a run.
  gh.classList.toggle('hidden', st.count < 2);
  if (st.count < 2) group.classList.remove('collapsed');
  else if (!st.touched) group.classList.add('collapsed');

  gh.querySelector('.tool-group-count').textContent =
    `${st.count} tool call${st.count !== 1 ? 's' : ''}${st.failed ? ` · ${st.failed} failed` : ''}`;
  gh.querySelector('.tool-group-summary').textContent = groupSummary(st);
  gh.classList.toggle('has-error', st.failed > 0);
  group.classList.toggle('running', st.running.size > 0);
}

export function endToolGroup() {
  if (!S.currentToolGroup) return;
  refreshToolGroup(S.currentToolGroup);
  S.currentToolGroup = null;
}

// `answered` marks an AskUserQuestion result: it comes back as an error (the
// answer rides on a denial — see the server's formatQuestionDenial) but is a
// perfectly ordinary reply, so it must not be rendered in red.
export function appendToolResult(id, output, isError, answered) {
  const el = toolCallEls.get(id);
  toolCallEls.delete(id);

  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const truncated = text.length > 800 ? text.slice(0, 800) + '\n…' : text;

  if (el) {
    const statusEl = el.querySelector('.tool-call-status');
    statusEl.className = 'tool-call-status ' + (isError ? 'status-error' : 'status-done');

    const body = el.querySelector('.tool-call-body');
    if (answered) {
      const label = document.createElement('div');
      label.className = 'tool-call-answer-label';
      label.textContent = 'Answer';
      body.appendChild(label);
    }
    const resultEl = document.createElement('pre');
    resultEl.className = 'tool-call-result' + (isError ? ' result-error' : '');
    resultEl.textContent = truncated;
    body.appendChild(resultEl);
    addCopyButton(resultEl);

    // The run's header reports what happened while it's folded away, so it has
    // to hear about the call finishing (and failing) too.
    const group = el.closest('.tool-group');
    const st = group && group._st;
    if (st) {
      st.running.delete(el);
      if (isError) st.failed++;
      refreshToolGroup(group);
    }
  } else {
    const div = document.createElement('div');
    div.className = 'tool-result' + (isError ? ' tool-result-error' : '');
    const pre = document.createElement('pre');
    pre.textContent = truncated;
    div.appendChild(pre);
    addCopyButton(pre);
    messagesEl.appendChild(div);
    scrollBottom();
  }
}

// The one-line gist of a call, shown beside the tool name on the collapsed row.
// Named tools get the argument that actually identifies the call; anything else
// falls back to the first string in the input.
export function getInputSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const clip = (s) => (s && s.length > 52 ? s.slice(0, 52) + '…' : s || '');
  switch (name) {
    case 'Bash': return clip(input.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return clip(input.file_path || input.path);
    case 'Glob': return clip(input.pattern);
    case 'Grep': return clip(`${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`);
    case 'WebFetch': return clip(input.url);
    case 'WebSearch': return clip(input.query);
    case 'Task': case 'Agent': return clip(input.description || (input.prompt || '').slice(0, 80));
    case 'TodoWrite': return `${(input.todos || []).length} items`;
    // {questions:[…]} has no top-level string, so the fallback would find
    // nothing and the row would read as a bare "AskUserQuestion".
    case 'AskUserQuestion': {
      const q = (input.questions || [])[0] || {};
      return clip(q.question || q.header);
    }
    default: {
      const entries = Object.entries(input);
      if (!entries.length) return '';
      const [, val] = entries[0];
      const head = clip(typeof val === 'string' ? val : JSON.stringify(val));
      return entries.length > 1 ? `${head}  +${entries.length - 1}` : head;
    }
  }
}

export function appendResultLine({ success, turns }) {
  endToolGroup();
  const div = document.createElement('div');
  div.className = 'result-line';
  const parts = [success ? 'Done' : 'Finished with errors'];
  if (turns != null) parts.push(`${turns} turn${turns !== 1 ? 's' : ''}`);
  div.textContent = parts.join(' · ');
  messagesEl.appendChild(div);
  scrollBottom();
}

export function appendCompactedDivider({ trigger, preTokens, postTokens }) {
  endToolGroup();
  S.lastAssistantBubble = null;
  const div = document.createElement('div');
  div.className = 'compacted-divider';
  let label = trigger === 'auto' ? 'Context auto-compacted' : 'Context compacted';
  if (preTokens && postTokens) label += ` — ${fmtTokens(preTokens)} → ${fmtTokens(postTokens)} tokens`;
  div.textContent = '⟳ ' + label;
  messagesEl.appendChild(div);
  scrollBottom();
}

export function appendErrorBubble(message) {
  endToolGroup();
  const div = document.createElement('div');
  div.className = 'error-bubble';
  div.textContent = message;
  messagesEl.appendChild(div);
  scrollBottom();
}

// A neutral, centered status line in the transcript (e.g. an auto-continue note).
export function appendInfoLine(text) {
  endToolGroup();
  S.lastAssistantBubble = null;
  const div = document.createElement('div');
  div.className = 'result-line';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollBottom();
}

export function appendInfoBubble(text) {
  S.lastAssistantBubble = null;
  endToolGroup();
  const div = mkBubble('assistant');
  const content = div.querySelector('.bubble-content');
  content._rawMd = text;
  renderMarkdown(content, text);
  messagesEl.appendChild(div);
  scrollBottom();
}

// Rebuild the chat from a persisted transcript (on connect / reconnect).
// A reconnect replays the *whole* transcript, and clearScreen() empties the
// list — which resets scrollTop to 0 and re-pins S.stickToBottom. Left alone,
// every re-appended bubble then calls scrollBottom() and the view jumps back
// to the bottom while the user is reading. So: suppress the per-item
// auto-scroll, rebuild, then restore where they were in one silent move.
export function renderHistory(items) {
  const wasPinned = S.stickToBottom;
  const prevTop   = messagesEl.scrollTop;
  S.suppressAutoScroll = true;
  clearScreen();
  try {
    for (const it of items) {
      switch (it.kind) {
        case 'user':        S.usage.messages++; appendUserBubble(it.text, it.ts); break;
        case 'text':        appendAssistantText(it.text, it.ts); break;
        case 'tool_use':    S.lastAssistantBubble = null; appendToolUse(it.id, it.name, it.input); break;
        case 'tool_result': appendToolResult(it.id, it.output, it.isError, it.answered); break;
        case 'result':      S.lastAssistantBubble = null; appendResultLine(it);
                            S.usage.turns        += it.turns       || 0;
                            S.usage.cost         += it.cost        || 0;
                            S.usage.inputTokens  += it.inputTokens  || 0;
                            S.usage.outputTokens += it.outputTokens || 0;
                            S.usage.cacheReadTokens  += it.cacheReadTokens  || 0;
                            S.usage.cacheWriteTokens += it.cacheWriteTokens || 0;
                            break;
        case 'error':       S.lastAssistantBubble = null; appendErrorBubble(it.message); break;
      }
    }
    S.lastAssistantBubble = null;
    endToolGroup();   // finalise (and collapse) any trailing tool-call group
  } finally {
    S.suppressAutoScroll = false;
  }
  // Content above the reader is identical after a replay, so their old
  // scrollTop still points at the same place.
  S.stickToBottom = wasPinned;
  messagesEl.scrollTop = wasPinned ? messagesEl.scrollHeight : prevTop;
}

export function mkBubble(role) {
  const div = document.createElement('div');
  div.className = `bubble bubble-${role}`;
  const content = document.createElement('div');
  content.className = 'bubble-content';
  div.appendChild(content);
  return div;
}
