/*
 * Sessions, read from Claude Code's own on-disk store.
 *
 * Multi-session browsing is built on the canonical JSONL transcripts at
 * ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — the same files the CLI
 * writes, so a session started here can be picked up there and vice versa. The
 * only thing this app keeps of its own is a pointer to the active session.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { STORE_DIR, ACTIVE_FILE } from './config.js';
import { runtime } from './state.js';

export function sessionFile(id) {
  return path.join(STORE_DIR, `${id}.jsonl`);
}

export function loadActive() {
  try {
    if (existsSync(ACTIVE_FILE)) {
      runtime.activeSessionId = JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')).sessionId || null;
    }
  } catch (e) { console.warn('Could not load active session:', e.message); }
  // A pointer to a session that no longer exists would replay an empty chat for
  // ever, so drop it.
  if (runtime.activeSessionId && !existsSync(sessionFile(runtime.activeSessionId))) {
    runtime.activeSessionId = null;
  }
}

export function saveActive() {
  try { writeFileSync(ACTIVE_FILE, JSON.stringify({ sessionId: runtime.activeSessionId })); }
  catch (e) { console.warn('Could not save active session:', e.message); }
}

export function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b.text || '')).join('');
  return JSON.stringify(content);
}

/**
 * Slash commands (e.g. /compact) are recorded in the transcript as user messages
 * wrapped in <command-name>…/<local-command-stdout>… tags. They are plumbing,
 * not conversation, so they are dropped from the rendered history.
 */
export function isCommandEcho(text) {
  return typeof text === 'string' &&
    (text.includes('<command-name>') || text.includes('<local-command-stdout>'));
}

// The two messages formatQuestionDenial() can produce. Fixed strings, so
// matching them is safe — and only ever consulted for a tool_result whose
// tool_use isn't in `toolNames` (a transcript truncated above the call).
const QUESTION_ANSWER_RE = /^The user (answered your question\(s\):|closed the question dialog without answering\.)/;

/**
 * An AskUserQuestion is answered by *denying* the tool call with the answer as
 * the message, so it lands in the transcript as is_error:true on a perfectly
 * ordinary reply. That is a deliberate choice made for the model's benefit, not
 * a failure the reader should see in red.
 */
export function isQuestionAnswer(toolName, isError, text) {
  if (!isError) return false;
  if (toolName === 'AskUserQuestion') return true;
  return toolName === undefined && QUESTION_ANSWER_RE.test(text);
}

/** Cap a tool result so one chatty command cannot flood the transcript. */
export function truncateOutput(raw) {
  return raw.length > 4000 ? raw.slice(0, 4000) + '\n…[truncated]' : raw;
}

/**
 * Turn one stored JSONL line into render item(s), matching the live event
 * shapes. Each item carries `ts` (epoch ms) so the UI can show when a message
 * happened after a reload.
 *
 * `toolNames` is tool_use id → tool name, carried across the whole transcript by
 * parseSession: a tool_result line only ever carries the id.
 */
export function lineToItems(line, toolNames = new Map()) {
  const items = [];
  const msg = line.message;
  if (line.isMeta || line.isSidechain || line.isCompactSummary || !msg) return items;
  const ts = line.timestamp ? Date.parse(line.timestamp) || undefined : undefined;
  const push = (o) => items.push(ts ? { ...o, ts } : o);

  if (line.type === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim() && !isCommandEcho(content)) push({ kind: 'user', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text) {
          if (!isCommandEcho(b.text)) push({ kind: 'user', text: b.text });
        } else if (b.type === 'tool_result') {
          const raw = blockText(b.content);
          const answered = isQuestionAnswer(toolNames.get(b.tool_use_id), !!b.is_error, raw);
          push({ kind: 'tool_result', id: b.tool_use_id, output: truncateOutput(raw),
            isError: !!b.is_error && !answered, answered });
        }
      }
    }
  } else if (line.type === 'assistant') {
    for (const b of (msg.content || [])) {
      if (b.type === 'text' && b.text) push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
    }
  }
  return items;
}

export function parseSession(id) {
  const file = sessionFile(id);
  if (!id || !existsSync(file)) return [];
  const items = [];
  const toolNames = new Map();
  for (const ln of readFileSync(file, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let obj; try { obj = JSON.parse(ln); } catch { continue; }
    items.push(...lineToItems(obj, toolNames));
  }
  return items;
}

export function sessionTitle(id) {
  try {
    for (const ln of readFileSync(sessionFile(id), 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      let obj; try { obj = JSON.parse(ln); } catch { continue; }
      if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) continue;
      const c = obj.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text || '') : '';
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 80 ? t.slice(0, 80) + '…' : t;
    }
  } catch {}
  return null;
}

export function listSessions() {
  if (!existsSync(STORE_DIR)) return [];
  const out = [];
  for (const f of readdirSync(STORE_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    let mtime = 0; try { mtime = statSync(path.join(STORE_DIR, f)).mtimeMs; } catch {}
    const title = sessionTitle(id);
    if (!title) continue;   // an empty shell the CLI left behind, not a conversation
    out.push({ id, title, updatedAt: mtime });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSession(id) {
  try { unlinkSync(sessionFile(id)); return true; }
  catch (e) { console.warn('Could not delete session:', e.message); return false; }
}
