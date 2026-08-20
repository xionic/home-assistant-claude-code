/*
 * Attachments. Files the user attaches are written to the app's own volume and
 * referenced by absolute path in the prompt; Claude reads them with the Read
 * tool, which handles images and PDFs natively. They are also served read-only
 * so the UI can show thumbnails.
 */
import { writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { UPLOAD_DIR } from './config.js';
import { log } from './log.js';

export function ensureUploadDir() {
  try { mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
}

/** Persist base64 attachments to disk, returning their absolute paths + web URLs. */
export function saveAttachments(attachments) {
  const out = [];
  if (!Array.isArray(attachments)) return out;
  for (const a of attachments) {
    if (!a || !a.data) continue;
    try {
      // Anything but a plain filename is stripped: the name comes from the
      // browser, and a path separator in it would escape the upload directory.
      const safe = (a.name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'file';
      const fname = `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`;
      const b64 = String(a.data).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      writeFileSync(path.join(UPLOAD_DIR, fname), buf);
      out.push({
        path: path.join(UPLOAD_DIR, fname), url: `uploads/${fname}`,
        name: a.name || fname, mediaType: a.mediaType || '',
        isImage: /^image\//.test(a.mediaType || ''),
      });
      log('INFO', `attachment saved: ${fname} (${a.mediaType || '?'}, ${Math.round(buf.length / 1024)} KB)`);
    } catch (e) { log('WARN', `attachment save failed: ${e.message}`); }
  }
  return out;
}

/** Bound growth: drop uploads older than a week on startup. */
export function cleanupUploads(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const now = Date.now();
    for (const f of readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try { if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p); } catch {}
    }
  } catch {}
}

/**
 * Rewrite a prompt so the model knows to read what was attached. The client has
 * already rendered thumbnails from its local copies, so nothing is echoed back.
 */
export function describeAttachments(text, saved) {
  if (!saved.length) return text;
  const list = saved.map((s) => `- ${s.path}`).join('\n');
  return (text ? text.trim() + '\n\n' : '') +
    `[The user attached ${saved.length} file${saved.length > 1 ? 's' : ''}. ` +
    `Use the Read tool to view ${saved.length > 1 ? 'them' : 'it'}:\n${list}]`;
}
