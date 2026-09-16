/*
 * Sizing the app frame to what is actually on screen.
 *
 * The app is a fixed frame — header, transcript, composer — and `100dvh` is the
 * obvious way to say "as tall as the viewport". Inside the Home Assistant
 * ingress iframe it is the wrong answer, because the iframe's viewport is not
 * the screen. HA sizes the panel iframe against the *large* viewport, so on a
 * mobile browser it is as tall as the screen would be with the URL bar hidden.
 * While the URL bar is showing, the bottom of that iframe — our composer — is
 * below the fold, and `html { overflow: hidden }` plus `overscroll-behavior`
 * mean nothing inside the app can scroll it into view. Dragging HA's own
 * toolbar does scroll it, and then our header goes off the *top* instead, with
 * no way back. That is the bug this module fixes: parts of the UI off the top
 * or bottom of a phone screen, and no gesture that reaches them.
 *
 * So we measure instead of assuming. Ingress is served from HA's own origin, so
 * we can read the iframe's box in the parent and the parent's visual viewport
 * (the same same-origin access links.js already relies on for more-info
 * dialogs), walk that up to the top window, and set two custom properties:
 *
 *   --app-top      how far down our own viewport the visible band starts
 *   --app-height   how tall that band is
 *
 * styles.css positions #app against those. Everything else — the flex column,
 * the single scroller — is unchanged; it just gets an honest height.
 *
 * The visual viewport is also what the on-screen keyboard shrinks, so the
 * composer stays above the keyboard for free.
 *
 * When the measurement is not available (cross-origin, no frameElement, an
 * ancestor we cannot see into) we fall back to `100dvh` and mark the document
 * `viewport-unmeasured`, which re-enables scroll chaining: if we cannot
 * guarantee everything is on screen, the user must at least be able to scroll
 * the page behind us to reach it.
 */

const MIN_HEIGHT = 200;   // never collapse the frame to nothing on a bad reading

/**
 * Walk up to the highest window we are allowed to read, accumulating where our
 * viewport's top sits in that window's client coordinates. Returns null the
 * moment an ancestor is cross-origin — we cannot know, so we do not guess.
 */
function frameChain() {
  let win = window;
  let offset = 0;
  const frames = [];
  for (let hops = 0; hops < 10; hops++) {
    let parent = null;
    try { parent = win.parent && win.parent !== win ? win.parent : null; } catch { parent = null; }
    if (!parent) break;

    // frameElement throws (or is null) the moment the parent is cross-origin.
    let frame = null;
    try { frame = win.frameElement; } catch { return null; }
    if (!frame) return null;

    // getBoundingClientRect is viewport-relative, so the parent's own scroll is
    // already in it. clientTop skips the iframe's border to reach its content.
    const rect = frame.getBoundingClientRect();
    offset += rect.top + frame.clientTop;
    frames.push(frame);
    win = parent;
  }
  return { win, offset, frames };
}

/**
 * The slice of *our* viewport that is actually on screen, in our own client
 * coordinates. Returns null when we cannot see far enough up the frame chain to
 * know — the caller then leaves CSS to its `100dvh` fallback.
 */
function visibleBand(chain) {
  if (!chain) return null;
  const { win, offset } = chain;

  // In the topmost window we can see, the visible band is the visual viewport:
  // what the URL bar, and the on-screen keyboard, actually leave showing.
  const vv = win.visualViewport;
  const bandTop = vv ? vv.offsetTop : 0;
  const bandHeight = vv ? vv.height : win.innerHeight;
  if (!bandHeight) return null;

  // Back into our coordinates, then clipped to our own viewport: the parts of
  // us that are neither above the screen nor below it.
  const top = Math.max(0, bandTop - offset);
  const bottom = Math.min(window.innerHeight, bandTop + bandHeight - offset);
  const height = bottom - top;
  if (height < MIN_HEIGHT) return null;    // a reading this small is not believable
  return { top, height };
}

/**
 * Keep Home Assistant's own toolbar on screen.
 *
 * Fitting ourselves to the visible band has a sting in its tail: it works just
 * as well when the page *above* us has been scrolled away. HA's panel page is
 * taller than the screen for the same URL-bar reason, so dragging its toolbar
 * scrolls it off the top — and because we then re-fit into the space it vacated,
 * the app looks completely normal with HA's menu button gone and no hint that
 * anything is scrolled. Before we measured, the app's own header disappeared at
 * the same time, which at least told you what had happened.
 *
 * Nothing in the app can scroll that back (`overscroll-behavior` sees to that),
 * so we put it back ourselves. We are the panel's whole content, so there is
 * nothing up there worth scrolling to — only chrome worth keeping.
 */
function keepChromeOnScreen(chain) {
  if (!chain || !chain.frames.length) return;    // not framed: nothing above us
  const { win, frames } = chain;
  let doc;
  try {
    if (!win.scrollY) return;                    // already where it should be
    doc = win.document.scrollingElement;
  } catch { return; }
  if (!doc) return;

  // Only when we really are the page's content. If an ancestor has scrolling of
  // its own to do, that is its business and we leave it alone.
  const outermost = frames[frames.length - 1];
  if (outermost.offsetHeight < doc.scrollHeight * 0.5) return;
  try { win.scrollTo(0, 0); } catch { /* not ours to scroll */ }
}

let pending = false;
let settleTimer = null;

export function applyViewport() {
  pending = false;
  const band = visibleBand(frameChain());
  const root = document.documentElement;
  if (!band) {
    root.style.removeProperty('--app-top');
    root.style.removeProperty('--app-height');
    root.classList.add('viewport-unmeasured');
    return;
  }
  root.classList.remove('viewport-unmeasured');
  root.style.setProperty('--app-top', `${Math.round(band.top)}px`);
  root.style.setProperty('--app-height', `${Math.round(band.height)}px`);
}

// Several of these fire together (a URL bar collapsing resizes and scrolls at
// once); one measurement per frame is enough.
//
// Putting HA's chrome back waits for things to stop moving instead. It is a
// correction, and correcting mid-gesture would mean wrestling the finger that
// is still on the screen; a drag keeps resetting this timer and is only undone
// once it ends.
function schedule() {
  if (!pending) {
    pending = true;
    requestAnimationFrame(applyViewport);
  }
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    keepChromeOnScreen(frameChain());
    applyViewport();
  }, 200);
}

/**
 * Listen everywhere the band can move: our own resize, the visual viewport
 * changing size or position, and — the one that matters under ingress — any
 * ancestor page scrolling, which slides our iframe up and down the screen.
 */
export function watchViewport() {
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule);
    window.visualViewport.addEventListener('scroll', schedule);
  }

  let win = window;
  for (let hops = 0; hops < 10; hops++) {
    let parent = null;
    try { parent = win.parent && win.parent !== win ? win.parent : null; } catch { break; }
    if (!parent) break;
    try {
      // Passive: we only ever measure in response, never block the scroll.
      parent.addEventListener('scroll', schedule, { passive: true });
      parent.addEventListener('resize', schedule);
      if (parent.visualViewport) {
        parent.visualViewport.addEventListener('resize', schedule);
        parent.visualViewport.addEventListener('scroll', schedule);
      }
    } catch { break; }   // cross-origin — nothing above here to watch
    win = parent;
  }

  applyViewport();
  // HA sizes the panel iframe after its own layout settles, and a phone browser
  // reports a stale height for a beat after load; re-measure once things stop
  // moving rather than trusting the first reading. `schedule` rather than a bare
  // `applyViewport` so a page that loaded already scrolled — a reload while HA's
  // toolbar was pushed off — is put right too.
  setTimeout(schedule, 250);
  window.addEventListener('load', schedule);
}
