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

// Slow enough to watch the whole arc. A page turn is the one animation in a
// reader worth seeing, and at the old third of a second the sheet was gone
// before the eye had followed it — which made the page look like it had
// simply changed, with some decoration playing afterwards.
const DURATION_MS = 820;
// Holding the arrow key or flicking through a chapter is a different
// intention: there, each turn should get out of the way of the next.
const FAST_MS = 380;

let pageColor = "#f7f3e9"; // the reader's default parchment, until told otherwise
let running = null;
let lastFinish = 0;

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

// A still of the turning page, drawn into the leaf's own footprint. Copying
// the pixels is a single GPU blit and leaves the original untouched, which
// matters because the original stays in the page cache ready to be shown
// again.
function snapshotInto(sources, rect) {
  try {
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) return null;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.floor(width * dpr));
    out.height = Math.max(1, Math.floor(height * dpr));
    const ctx = out.getContext("2d");
    // The leaf reaches to the spine, which is slightly wider than the page
    // itself; the gutter it gains is painted as paper so the sheet has no
    // transparent edge.
    ctx.fillStyle = pageColor;
    ctx.fillRect(0, 0, out.width, out.height);

    let drew = false;
    for (const el of sources) {
      for (const c of el.querySelectorAll("canvas")) {
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        ctx.drawImage(c, (r.left - rect.left) * dpr, (r.top - rect.top) * dpr,
                      r.width * dpr, r.height * dpr);
        drew = true;
      }
    }
    if (!drew) return null;
    out.style.width = "100%";
    out.style.height = "100%";
    out.style.display = "block";
    return out;
  } catch (_) {
    return null; // a tainted or zero-sized canvas just means a plain leaf
  }
}

// EPUB draws its columns inside one iframe, so there is no element per page
// to measure or photograph. This gives the sheet the right footprint anyway.
function epubBox(stage, dir) {
  const frame = stage.querySelector("#epubContainer iframe");
  if (!frame) return null;
  const s = stage.getBoundingClientRect();
  const r = frame.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  // A wide screen is laid out as two columns, and only half of it should
  // lift; a narrow one is a single column and turns whole.
  const spread = r.width > r.height * 1.15;
  const spine = r.left + r.width / 2;
  const rect = spread
    ? (dir > 0 ? { left: spine, right: r.right, top: r.top, bottom: r.bottom }
               : { left: r.left, right: spine, top: r.top, bottom: r.bottom })
    : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  return {
    box: {
      top: Math.max(0, rect.top - s.top),
      bottom: Math.max(0, s.bottom - rect.bottom),
      left: Math.max(0, rect.left - s.left),
      right: Math.max(0, s.right - rect.right),
    },
    snapshot: null,
  };
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) {
    return false;
  }
}

/**
 * Photograph each half of what's currently on screen.
 *
 * Each slot reaches to the spine rather than stopping at the page's own
 * edge, so a sheet hinged there lands exactly on the facing page instead of
 * a few pixels adrift of it.
 */
export function captureSpread(stage) {
  if (!stage) return null;
  const s = stage.getBoundingClientRect();
  const pages = [...stage.querySelectorAll(".pdf-page-wrapper")];
  if (!pages.length) return null;
  const rs = pages.map((p) => p.getBoundingClientRect());
  if (!rs[0].width) return null;
  const twoUp = pages.length > 1;
  const spine = twoUp ? (rs[0].right + rs[1].left) / 2 : null;

  const slot = (el, r, which) => {
    const rect = !twoUp
      ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      : which === "left"
        ? { left: r.left, right: spine, top: r.top, bottom: r.bottom }
        : { left: spine, right: r.right, top: r.top, bottom: r.bottom };
    return {
      box: {
        top: Math.max(0, rect.top - s.top),
        bottom: Math.max(0, s.bottom - rect.bottom),
        left: Math.max(0, rect.left - s.left),
        right: Math.max(0, s.right - rect.right),
      },
      canvas: snapshotInto([el], rect),
    };
  };

  return {
    twoUp,
    left: slot(pages[0], rs[0], "left"),
    right: twoUp ? slot(pages[1], rs[1], "right") : null,
  };
}

/**
 * Assemble the turn from a photograph of the spread before the swap and one
 * of the spread after it.
 *
 * A book turns one leaf, and that leaf has a page on each side. Going
 * forward from 4|5 to 6|7, the sheet carrying 5 lifts; its reverse is 6; and
 * 7 is revealed behind it. Page 4 stays where it is until the sheet comes
 * down on top of it. Swapping the whole opening at once instead — which is
 * what the content underneath actually does — makes the left-hand page jump
 * to its new number while the right-hand one is still in mid-air. The
 * underlay below holds the old left page in place for the duration, so only
 * one page is ever moving and nothing changes before it should.
 */
export function buildScene(before, after, dir) {
  if (!before) return null;
  if (!before.twoUp) {
    return { box: before.left.box, snapshot: before.left.canvas, back: null, underlay: null };
  }
  const settled = after && after.twoUp ? after : null;
  if (dir > 0) {
    return {
      box: before.right.box,
      snapshot: before.right.canvas,          // the page being turned
      back: settled ? settled.left.canvas : null,  // its reverse: the new left page
      underlay: { box: before.left.box, canvas: before.left.canvas },
    };
  }
  return {
    box: before.left.box,
    snapshot: before.left.canvas,
    back: settled ? settled.right.canvas : null,
    underlay: before.right ? { box: before.right.box, canvas: before.right.canvas } : null,
  };
}

/**
 * Sweep the outgoing page away, revealing whatever is already underneath.
 *
 * @param {Element} stage        the .reader-stage element
 * @param {number} dir           +1 forward, -1 back
 * @param {{box, snapshot}|null} visual  the measured footprint of the page
 *                                 being left behind, and a still of it
 */
export function playTurn(stage, dir, visual = null) {
  if (!stage || prefersReducedMotion()) return 0;

  // Turning quickly shouldn't queue up a backlog — the newest turn replaces
  // whatever was still playing, and takes the short version.
  const hurried = !!running || (performance.now() - lastFinish) < 260;
  if (running) {
    running.remove();
    running = null;
  }
  const ms = hurried ? FAST_MS : DURATION_MS;

  const measuredEarly = visual || epubBox(stage, dir);
  const leaf = document.createElement("div");
  const seamless = !!(measuredEarly && measuredEarly.underlay && measuredEarly.back);
  // Without a facing page to come down on, the sheet fades out at the end
  // instead of simply vanishing off the background.
  leaf.className = `page-leaf ${dir > 0 ? "forward" : "back"}${seamless ? "" : " fades"}`;
  leaf.style.setProperty("--page-bg", pageColor);
  leaf.style.setProperty("--turn-ms", `${ms}ms`);

  const measured = measuredEarly;
  const box = measured && measured.box;
  const snapshot = measured && measured.snapshot;
  if (box) {
    leaf.style.top = `${box.top}px`;
    leaf.style.bottom = `${box.bottom}px`;
    leaf.style.left = `${box.left}px`;
    leaf.style.right = `${box.right}px`;
  }

  // Two faces, so the sheet can go all the way over and you see its reverse
  // on the way. Without a back face a 180° turn shows the page mirrored,
  // which is the thing that gives away a fake page turn immediately.
  const front = document.createElement("span");
  front.className = "leaf-face leaf-front";
  if (snapshot) front.appendChild(snapshot);
  else front.classList.add("blank");

  const back = document.createElement("span");
  back.className = "leaf-face leaf-back";
  if (measured && measured.back) back.appendChild(measured.back);
  else back.classList.add("blank");

  // Shading that deepens as the leaf turns edge-on: a sheet catching the
  // light rather than a rectangle rotating.
  const shade = document.createElement("span");
  shade.className = "page-leaf-shade";
  front.appendChild(shade);

  leaf.append(front, back);

  // Holds the page that is NOT turning exactly as it was, over the top of
  // the content that has already changed underneath.
  let under = null;
  if (measured && measured.underlay && measured.underlay.canvas) {
    under = document.createElement("div");
    under.className = "page-underlay";
    const u = measured.underlay.box;
    under.style.top = `${u.top}px`;
    under.style.bottom = `${u.bottom}px`;
    under.style.left = `${u.left}px`;
    under.style.right = `${u.right}px`;
    under.appendChild(measured.underlay.canvas);
    stage.appendChild(under);
  }

  stage.appendChild(leaf);
  running = leaf;

  const done = () => {
    leaf.remove();
    // Removed with the sheet, never before it: the sheet is lying over this
    // by then, so the real page beneath takes its place unseen.
    if (under) under.remove();
    if (running === leaf) {
      running = null;
      lastFinish = performance.now();
    }
  };
  leaf.addEventListener("animationend", (e) => {
    if (e.target === leaf) done();
  }, { once: true });
  // Belt and braces: if the animation never fires (a backgrounded tab, say)
  // the leaf must not be left sitting over the page.
  setTimeout(done, ms + 400);
  return ms;
}
