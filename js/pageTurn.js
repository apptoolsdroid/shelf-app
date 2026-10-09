// ============================================================================
// The page-turn animation.
//
// A paper-coloured leaf that swings about the spine, so turning a page reads
// as turning a page rather than the text silently becoming different text.
//
// The colour is the important part. A generic white flap over a cream EPUB or
// a grey scanned PDF looks like a bug, so the leaf is painted with the page's
// own background, sampled from whatever is actually on screen: the rendered
// canvas for a PDF, the chapter's own body colour for an EPUB. Everything
// else — the gradient towards the spine, the shadow it throws — is derived
// from that one colour so it stays consistent on any book.
// ============================================================================

let pageColor = "#f7f3e9"; // the reader's default parchment, until told otherwise
let running = null;

export function setPageColor(color) {
  if (color) pageColor = color;
}

export function getPageColor() {
  return pageColor;
}

// Reads the actual paper colour out of a rendered PDF page. Sampled a few
// pixels in from the top-left corner, which is margin on essentially every
// book; a page whose corner is dark (a full-bleed cover, say) is used as-is,
// since that really is what the paper looks like there.
export function samplePdfColor(canvas) {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const d = ctx.getImageData(3, 3, 1, 1).data;
    if (d[3] === 0) return null; // transparent corner tells us nothing
    setPageColor(`rgb(${d[0]}, ${d[1]}, ${d[2]})`);
    return pageColor;
  } catch (_) {
    return null; // a tainted canvas isn't worth an error over
  }
}

// Same idea for EPUB, where the "paper" is whatever the chapter's own
// stylesheet set on its body.
export function sampleEpubColor(doc) {
  try {
    if (!doc || !doc.body) return null;
    const bg = doc.defaultView.getComputedStyle(doc.body).backgroundColor;
    if (!bg || bg === "transparent" || /rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) return null;
    setPageColor(bg);
    return pageColor;
  } catch (_) {
    return null;
  }
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {
    return false;
  }
}

// Where the page sits inside the stage, as insets. Falls back to the whole
// stage when there's nothing measurable yet — better a slightly loose
// animation than none.
function pageBox(stage) {
  const page = stage.querySelector(".pdf-page-wrapper, #epubContainer iframe");
  if (!page) return null;
  const s = stage.getBoundingClientRect();
  const p = page.getBoundingClientRect();
  if (!p.width || !p.height) return null;
  // A spread is two wrappers side by side; the leaf should cover one of them,
  // so measure across whatever is actually showing.
  const all = [...stage.querySelectorAll(".pdf-page-wrapper")];
  const left = all.length > 1 ? Math.min(...all.map((n) => n.getBoundingClientRect().left)) : p.left;
  const right = all.length > 1 ? Math.max(...all.map((n) => n.getBoundingClientRect().right)) : p.right;
  return {
    top: Math.max(0, p.top - s.top),
    bottom: Math.max(0, s.bottom - p.bottom),
    left: Math.max(0, left - s.left),
    right: Math.max(0, s.right - right),
    width: right - left,
  };
}

/**
 * Play one page turn over `stage`.
 * @param {Element} stage      the .reader-stage element
 * @param {number} dir         +1 for forward, -1 for back
 */
export function playTurn(stage, dir) {
  if (!stage || prefersReducedMotion()) return;

  // Turning quickly through a book shouldn't queue up a backlog of
  // animations — the newest turn replaces whatever was still playing.
  if (running) {
    running.remove();
    running = null;
  }

  const leaf = document.createElement("div");
  leaf.className = `page-leaf ${dir > 0 ? "forward" : "back"}`;
  leaf.style.setProperty("--page-bg", pageColor);

  // Sized to the page actually on screen rather than to the whole stage. A
  // fitted page is centred with margins either side, and a leaf that swings
  // across the empty margins too looks like a panel sliding rather than a
  // page turning.
  const box = pageBox(stage);
  if (box) {
    leaf.style.top = `${box.top}px`;
    leaf.style.bottom = `${box.bottom}px`;
    if (dir > 0) leaf.style.right = `${box.right}px`;
    else leaf.style.left = `${box.left}px`;
    leaf.style.width = `${box.width / 2}px`;
  }

  stage.appendChild(leaf);
  running = leaf;

  const done = () => {
    leaf.remove();
    if (running === leaf) running = null;
  };
  leaf.addEventListener("animationend", done, { once: true });
  // Belt and braces: if the animation never fires (a backgrounded tab, say)
  // the leaf must not be left sitting over the page.
  setTimeout(done, 700);
}
