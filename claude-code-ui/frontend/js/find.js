/*
 * Find in chat — header search, /find, or Ctrl/Cmd+F.
 */
import { findBar, findBtn, findClose, findCount, findInput, findNext, findPrev, messagesEl } from './dom.js';

// ── Find in chat ─────────────────────────────────────────────────────────────
export let findHits = [];
export let findIndex = -1;

export function clearFindMarks() {
  const marks = messagesEl.querySelectorAll('mark.find-hit');
  marks.forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  if (marks.length) messagesEl.normalize();
  findHits = [];
  findIndex = -1;
}

export function doFind() {
  clearFindMarks();
  const q = findInput.value;
  if (q) {
    const ql = q.toLowerCase();
    const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.toLowerCase().includes(ql)) nodes.push(n);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let last = 0, idx = lower.indexOf(ql);
      while (idx !== -1) {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        findHits.push(mark);
        last = idx + q.length;
        idx = lower.indexOf(ql, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    if (findHits.length) { findIndex = 0; setCurrentHit(); }
  }
  updateFindCount();
}

export function setCurrentHit() {
  findHits.forEach((m) => m.classList.remove('find-current'));
  const m = findHits[findIndex];
  if (!m) return;
  m.classList.add('find-current');
  const tg = m.closest('.tool-group');
  // Opened on purpose, so it must stay open even if the run is still growing.
  if (tg) { tg.classList.remove('collapsed'); if (tg._st) tg._st.touched = true; }
  const tc = m.closest('.tool-call');
  if (tc && !tc.classList.contains('expanded')) tc.classList.add('expanded');
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function moveFind(delta) {
  if (!findHits.length) return;
  findIndex = (findIndex + delta + findHits.length) % findHits.length;
  setCurrentHit();
  updateFindCount();
}

export function updateFindCount() {
  findCount.textContent = findHits.length ? `${findIndex + 1}/${findHits.length}` : '0/0';
}

export function openFind() {
  findBar.classList.remove('hidden');
  findBtn.classList.add('active');
  findInput.focus();
  findInput.select();
  if (findInput.value) doFind();
}

export function closeFind() {
  clearFindMarks();
  updateFindCount();
  findBar.classList.add('hidden');
  findBtn.classList.remove('active');
}

findBtn.onclick = () => {
  if (findBar.classList.contains('hidden')) openFind();
  else closeFind();
};
findInput.oninput = doFind;
findInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); moveFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
};
findPrev.onclick  = () => moveFind(-1);
findNext.onclick  = () => moveFind(1);
findClose.onclick = closeFind;

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openFind();
  }
});
