/*
 * Turning a reply into something you can click: markdown rendering, entity ids
 * linked to their Home Assistant more-info dialog, and copy buttons on code blocks.
 * 
 * Only entity ids the server says exist are linked — a regex alone would happily
 * link "configuration.yaml".
 */
import { S } from './state.js';
import { messagesEl } from './dom.js';

// ── Home Assistant deep links ────────────────────────────────────────────────
// The server sends the real entity ids (so we never link something that doesn't
// exist) and the automation entity_id → editor id map. We're served same-origin
// under HA ingress, so root-relative links resolve against whatever URL HA is on
// (local, Nabu Casa, …) — but they must target _top to escape the ingress iframe.

// HA names its top window "ha-main-window" precisely so ingress iframes can find
// it (this mirrors the frontend's own src/common/dom/get_main_window.ts). Falls
// back to `top`, and to null if it's unreachable (cross-origin / standalone).
export const HA_MAIN_WINDOW_NAME = 'ha-main-window';
export function haMainWindow() {
  try {
    if (window.name === HA_MAIN_WINDOW_NAME) return window;
    if (window.parent && window.parent.name === HA_MAIN_WINDOW_NAME) return window.parent;
    return window.top || null;
  } catch { return null; }   // cross-origin — we're not inside HA
}

// Same shape as the frontend's fireEvent (bubbles + composed).
export function haFire(target, type, detail) {
  target.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

// Open the entity's more-info dialog — exactly what clicking the entity anywhere
// in HA does, so each domain gets its usual controls (a switch gets its toggle,
// climate gets the thermostat, a sensor gets its history chart). It's a dialog,
// so nothing navigates: we stay inside the app/frontend.
export function openMoreInfo(entityId) {
  const w = haMainWindow();
  if (!w) return false;
  try {
    const root = w.document.querySelector('home-assistant');
    if (!root) return false;
    haFire(root, 'hass-more-info', { entityId });
    return true;
  } catch { return false; }
}

// SPA-navigate the HA frontend, the way HA's own navigate() does — no page load,
// no handing the URL to an external browser.
export function haNavigate(path) {
  const w = haMainWindow();
  if (!w) return false;
  try {
    w.history.pushState(null, '', path);
    haFire(w, 'location-changed', { replace: false });
    return true;
  } catch { return false; }
}

// Fallback URL, used for middle-click/copy-link and if we can't reach the HA
// frontend to open a dialog.
export function haEntityUrl(id) {
  if (id.startsWith('automation.') && S.haAutomationIds[id]) {
    return `/config/automation/edit/${encodeURIComponent(S.haAutomationIds[id])}`;
  }
  return `/history?entity_id=${encodeURIComponent(id)}`;
}

export function mkEntityLink(id) {
  const a = document.createElement('a');
  const isAutomation = id.startsWith('automation.') && S.haAutomationIds[id];
  a.className = 'ha-entity-link';
  a.href = haEntityUrl(id);       // real href: middle-click/copy still work
  a.target = '_top';
  a.rel = 'noopener';
  a.textContent = id;
  a.title = isAutomation ? `Edit automation ${id}` : `Open ${id} in Home Assistant`;
  a.addEventListener('click', (e) => {
    // Leave modified clicks (new tab/window) to the browser.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    // An automation you just made is most useful in its editor; everything else
    // opens its more-info dialog.
    const handled = isAutomation
      ? haNavigate(`/config/automation/edit/${encodeURIComponent(S.haAutomationIds[id])}`)
      : openMoreInfo(id);
    if (handled) e.preventDefault();   // otherwise fall through to the href
  });
  return a;
}

export const ENTITY_RE = /\b[a-z_]+\.[a-z0-9_]+\b/g;

// Turn bare entity ids in the reply into links. Skips fenced code blocks (<pre>)
// so YAML stays clean and copy-pasteable, but does run inside inline <code>,
// which is where Claude usually names an entity.
export function linkifyEntities(root) {
  if (!S.haEntities.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || n.nodeValue.indexOf('.') === -1) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest('a, pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue;
    let frag = null;
    let last = 0;
    let m;
    ENTITY_RE.lastIndex = 0;
    while ((m = ENTITY_RE.exec(text))) {
      if (!S.haEntities.has(m[0])) continue;
      frag = frag || document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(mkEntityLink(m[0]));
      last = m.index + m[0].length;
    }
    if (frag) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
}

// Links Claude writes itself (e.g. to a dashboard). Internal ones SPA-navigate
// the HA frontend so they open in the app rather than being handed to a browser;
// external ones open in a new tab.
export function fixAnchorTargets(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    if (a.classList.contains('ha-entity-link')) continue;   // already wired
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (href.startsWith('/')) {
      a.target = '_top';
      a.rel = 'noopener';
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (haNavigate(href)) e.preventDefault();
      });
    }
  }
}

export function renderMarkdown(el, raw) {
  el.innerHTML = marked.parse(raw);
  linkifyEntities(el);
  fixAnchorTargets(el);
  el.querySelectorAll('pre').forEach(addCopyButton);
}

// Copy text to the clipboard, with a fallback for non-secure contexts (the HA
// app / ingress isn't always a secure origin, where navigator.clipboard is
// undefined). Returns a promise resolving to true on success.
export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }
  return new Promise((resolve) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    resolve(ok);
  });
}

// Add a small "Copy" button to a <pre> block. Captures the code text *before*
// inserting the button so the button's own label can't leak into the copy.
export function addCopyButton(pre) {
  if (pre.querySelector(':scope > .copy-btn')) return;
  const codeEl = pre.querySelector('code');
  const text = (codeEl || pre).textContent;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.title = 'Copy to clipboard';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyText(text).then((ok) => {
      btn.textContent = ok ? 'Copied' : 'Failed';
      btn.classList.toggle('copied', ok);
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
    });
  });
  pre.appendChild(btn);
}

// Re-render assistant bubbles from their stored markdown once link targets
// arrive (the map lands slightly after the history replay on connect).
export function relinkRenderedBubbles() {
  for (const content of messagesEl.querySelectorAll('.bubble-assistant .bubble-content')) {
    if (content._rawMd) renderMarkdown(content, content._rawMd);
  }
}
