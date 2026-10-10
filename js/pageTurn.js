// ============================================================================
// The page-turn animation.
//
// The ordering here is the whole trick. The obvious implementation — start an
// animation, then swap the content when the new page finishes rendering —
// looks wrong, because rendering a Retina PDF page takes longer than the
// animation does: the leaf sweeps across, nothing has changed underneath, and
// then the page pops a beat later. Two separate events where there should be
// one.
//
// So it works the other way round. The content is swapped *first*, while it's
// still hidden, and the leaf on top is a picture of the page you were just
// on. As it rotates away it reveals the page that is already there. There is
// nothing left to wait for, so there is nothing left to fall out of step.
//
// Both directions rotate the outgoing page about the spine: forward it swings
// away to the left, back it swings away to the right. The page beneath is
// revealed either way.
// ============================================================================

const DURATION_MS = 360;

let pageColor = "#f7f3e9"; // the reader's default parchment, until told otherwise
let running = null;

export function setPageColor(color) {
  if (color) pageColor = color;
}

export function getPageColor() {
  return pageColor;
}

export function duration() {
  return DURATION_MS;
}

// Reads the actual paper colour out of a rendered PDF page. Sampled a few
// pixels in from the top-left corner, which is margin on essentially every
// book.
export function samplePdfColor(canvas) {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const d = ctx.getImageData(3, 3, 1, 1).data;
    if (d[3] === 0) return null;
    setPageColor(`rgb(${d[0]}, ${d[1]}, ${d[2]})`);
    return pageColor;
  } catch (_) {
    return null;
  }
}

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

// A still of a rendered page, for the leaf to carry. Copying the pixels is a
// single GPU blit and leaves the original untouched, which matters because
// the original stays in the page cache ready to be shown again.
export function snapshotOf(element) {
  try {
    const canvases = [...element.querySelectorAll("canvas")];
    if (!canvases.length) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.floor(rect.width * dpr));
    out.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = out.getContext("2d");
    ctx.fillStyle = pageColor;
    ctx.fillRect(0, 0, out.width, out.height);

    // Each page canvas is drawn where it sits relative to the whole group, so
    // a two-page spread comes out as one image of the spread.
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      ctx.drawImage(c, (r.left - rect.left) * dpr, (r.top - rect.top) * dpr,
                    r.width * dpr, r.height * dpr);
    }
    out.style.width = "100%";
    out.style.height = "100%";
    out.style.display = "block";
    return out;
  } catch (_) {
    return null; // a tainted or zero-sized canvas just means a plain leaf
  }
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {
    return false;
  }
}

// Where the page sits inside the stage, as insets.
function pageBox(stage) {
  const pages = [...stage.querySelectorAll(".pdf-page-wrapper")];
  const el = pages[0] || stage.querySelector("#epubContainer iframe");
  if (!el) return null;
  const s = stage.getBoundingClientRect();
  const first = el.getBoundingClientRect();
  if (!first.width || !first.height) return null;
  const left = pages.length ? Math.min(...pages.map((n) => n.getBoundingClientRect().left)) : first.left;
  const right = pages.length ? Math.max(...pages.map((n) => n.getBoundingClientRect().right)) : first.right;
  return {
    top: Math.max(0, first.top - s.top),
    bottom: Math.max(0, s.bottom - first.bottom),
    left: Math.max(0, left - s.left),
    right: Math.max(0, s.right - right),
  };
}

/**
 * Sweep the outgoing page away, revealing whatever is already underneath.
 *
 * @param {Element} stage        the .reader-stage element
 * @param {number} dir           +1 forward, -1 back
 * @param {Element|null} snapshot  a still of the page being left behind;
 *                                 without one the leaf is plain paper
 */
export function playTurn(stage, dir, snapshot = null) {
  if (!stage || prefersReducedMotion()) return;

  // Turning quickly shouldn't queue up a backlog — the newest turn replaces
  // whatever was still playing.
  if (running) {
    running.remove();
    running = null;
  }

  const leaf = document.createElement("div");
  leaf.className = `page-leaf ${dir > 0 ? "forward" : "back"}`;
  leaf.style.setProperty("--page-bg", pageColor);
  leaf.style.setProperty("--turn-ms", `${DURATION_MS}ms`);

  const box = pageBox(stage);
  if (box) {
    leaf.style.top = `${box.top}px`;
    leaf.style.bottom = `${box.bottom}px`;
    leaf.style.left = `${box.left}px`;
    leaf.style.right = `${box.right}px`;
  }

  if (snapshot) {
    leaf.classList.add("has-page");
    leaf.appendChild(snapshot);
  }

  // Shading that deepens as the leaf turns edge-on, which is what sells it as
  // a sheet catching the light rather than a rectangle rotating.
  const shade = document.createElement("span");
  shade.className = "page-leaf-shade";
  leaf.appendChild(shade);

  stage.appendChild(leaf);
  running = leaf;

  const done = () => {
    leaf.remove();
    if (running === leaf) running = null;
  };
  leaf.addEventListener("animationend", (e) => {
    if (e.target === leaf) done();
  }, { once: true });
  // Belt and braces: if the animation never fires (a backgrounded tab, say)
  // the leaf must not be left sitting over the page.
  setTimeout(done, DURATION_MS + 400);
}
