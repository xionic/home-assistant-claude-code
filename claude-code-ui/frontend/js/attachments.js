/*
 * Attaching images, photos and files.
 * 
 * Images are downscaled in the browser before sending: a modern phone camera
 * produces files far larger than the model needs, and a WebSocket message carrying
 * several of them raw is slow enough to look broken.
 */
import { updateSendBtn } from './composer.js';
import { attachBtn, attachInput, attachPreview, inputForm, promptInput } from './dom.js';
import { appendErrorBubble } from './transcript.js';

// ── Attachments ───────────────────────────────────────────────────────────────
// Files/photos the user attaches to the next prompt. Each: { file, name,
// mediaType, isImage, url } where url is an object URL used only for the preview.
export let attachments = [];
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;   // ~25 MB total, keeps the WS message sane

export function looksLikeImage(file) {
  return /^image\//.test(file.type || '') ||
    /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i.test(file.name || '');
}

export function addFiles(fileList) {
  // Array.from (not for..of) so it works even if the webview's FileList isn't
  // iterable, and don't skip size===0 — some mobile pickers report 0 for
  // multi-selected photos that still read fine, so skipping them lost everything.
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let total = attachments.reduce((n, a) => n + (a.file.size || 0), 0);
  let added = 0, skipped = 0;
  for (const file of files) {
    if (!file) continue;
    const size = file.size || 0;
    if (size && total + size > MAX_ATTACH_BYTES) { skipped++; continue; }
    total += size;
    const isImage = looksLikeImage(file);
    let url = null;
    try { if (isImage) url = URL.createObjectURL(file); } catch {}
    attachments.push({ file, name: file.name || 'file', mediaType: file.type || '', isImage, url });
    added++;
  }
  if (skipped) appendErrorBubble(`${skipped} file${skipped > 1 ? 's' : ''} skipped — attachments are limited to ~25 MB total (images are shrunk automatically).`);
  if (!added && !skipped) appendErrorBubble('Could not attach the selected file(s).');
  renderAttachments();
  updateSendBtn();
}

export function removeAttachment(i) {
  const a = attachments[i];
  if (a && a.url) URL.revokeObjectURL(a.url);
  attachments.splice(i, 1);
  renderAttachments();
  updateSendBtn();
}

export function clearAttachments() {
  for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url);
  attachments = [];
  renderAttachments();
}

export function renderAttachments() {
  attachPreview.innerHTML = '';
  if (!attachments.length) { attachPreview.classList.add('hidden'); return; }
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (a.isImage ? ' attach-chip-img' : '');
    if (a.isImage) {
      const img = document.createElement('img');
      img.src = a.url; img.alt = a.name;
      chip.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'attach-chip-name';
      label.textContent = a.name;
      chip.appendChild(label);
    }
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'attach-chip-remove'; rm.textContent = '✕';
    rm.title = 'Remove'; rm.onclick = () => removeAttachment(i);
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
  attachPreview.classList.remove('hidden');
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Images are downscaled to ~1568px (Claude's effective max useful edge) and
// re-encoded as JPEG before sending: this shrinks the payload dramatically (so
// several photos fit), and normalizes formats like HEIC to something Claude
// reads. Non-images (and anything that won't decode) are read as-is.
export const MAX_IMG_DIM = 1568;
export function fileToDataURL(file, isImage) {
  if (!isImage) return readFileAsDataURL(file);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_IMG_DIM / Math.max(img.width, img.height) || 1);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      } catch {
        URL.revokeObjectURL(url);
        readFileAsDataURL(file).then(resolve, () => resolve(null));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); readFileAsDataURL(file).then(resolve, () => resolve(null)); };
    img.src = url;
  });
}

attachBtn.onclick = () => attachInput.click();
attachInput.onchange = () => { addFiles(attachInput.files); attachInput.value = ''; };

// Paste an image (e.g. a screenshot) straight into the prompt.
promptInput.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// Drag-and-drop files onto the composer.
['dragenter', 'dragover'].forEach((ev) => inputForm.addEventListener(ev, (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    e.preventDefault(); inputForm.classList.add('dragover');
  }
}));
['dragleave', 'dragend'].forEach((ev) => inputForm.addEventListener(ev, (e) => {
  if (e.target === inputForm) inputForm.classList.remove('dragover');
}));
inputForm.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    e.preventDefault(); addFiles(e.dataTransfer.files);
  }
  inputForm.classList.remove('dragover');
});
