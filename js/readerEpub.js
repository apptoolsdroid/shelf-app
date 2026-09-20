// ============================================================================
// EPUB reader, built on epub.js. Handles rendering, page turns, text
// selection -> underline, bookmarking the current position, and replaying
// saved underlines back onto the page.
// ============================================================================
import * as annotations from "./annotations.js";
import { attachSwipe } from "./gestures.js";

let book = null;
let rendition = null;
let onLocationChange = null;
let containerEl = null;
let resizeObserver = null;
let lastCfi = null;
let onTapCenter = null;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Roughly how far through the book we are, as a 0–1 fraction, for the progress
// bar on the cover. epub.js can give an exact percentage, but only after
// indexing every page of the book, which is slow on large titles and would
// stall opening. Position within the spine is instant and close enough to be
// useful at a glance.
function estimateProgress(location) {
  if (location && location.start && typeof location.start.percentage === "number" && location.start.percentage > 0) {
    return location.start.percentage;
  }
  try {
    const items = book.spine.spineItems;
    const idx = items.findIndex((it) => it.href === location.start.href);
    if (idx >= 0 && items.length > 0) return (idx + 1) / items.length;
  } catch (_) { /* fall through — a missing progress bar is not worth an error */ }
  return undefined;
}

export async function openEpub({ container, blob, savedLocation, onLocation, onTapCenter: tapCenter }) {
  onLocationChange = onLocation;
  onTapCenter = tapCenter;
  containerEl = container;
  const arrayBuffer = await blob.arrayBuffer();
  book = ePub(arrayBuffer);
  rendition = book.renderTo(container, {
    width: "100%",
    height: "100%",
    spread: "auto", // lets epub.js itself decide single vs. two-column layout by width
    flow: "paginated",
  });

  // epub.js renders each chapter inside its own iframe, so touch and key
  // events fired over the text never reach the host page. This hook runs for
  // every chapter as it's rendered and wires the gestures up inside that
  // iframe's own document, which is the only place they're observable.
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    if (!doc) return;
    attachSwipe(doc.documentElement, {
      onPrev: () => prevPage(),
      onNext: () => nextPage(),
    });
    // Tap zones. Clicks land inside the chapter's iframe and never reach the
    // host page, so the edges (page turn) and the middle (show/hide the bars)
    // both have to be handled in here.
    doc.addEventListener("click", (e) => {
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return; // selecting to underline
      const w = doc.documentElement.clientWidth || 1;
      const x = e.clientX;
      if (x < w * 0.25) prevPage();
      else if (x > w * 0.75) nextPage();
      else if (onTapCenter) onTapCenter();
    });
    doc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { prevPage(); e.preventDefault(); }
      if (e.key === "ArrowRight") { nextPage(); e.preventDefault(); }
    });
  });

  // Readable defaults. EPUBs ship wildly inconsistent styling, and many lean on
  // thin or tightly-leaded type that's hard work on a backlit screen — these
  // override the worst of it without flattening the book's own design.
  applyTypography();

  await rendition.display(savedLocation || undefined);

  rendition.on("relocated", (location) => {
    lastCfi = location.start.cfi;
    if (onLocationChange) onLocationChange(lastCfi, estimateProgress(location));
  });

  // Screen-size adjustment: re-flow columns/pagination whenever the reader's
  // available space changes (rotation, split-screen on iPad, window resize),
  // then jump back to exactly where the reader was.
  // Only re-flow when the space actually changed. Re-displaying the chapter
  // for a resize notification that changed nothing makes the text flash.
  let flowedFor = { w: 0, h: 0 };
  resizeObserver = new ResizeObserver(
    debounce(() => {
      const w = containerEl.clientWidth;
      const h = containerEl.clientHeight;
      if (Math.abs(w - flowedFor.w) < 4 && Math.abs(h - flowedFor.h) < 4) return;
      flowedFor = { w, h };
      rendition.resize(w, h);
      if (lastCfi) rendition.display(lastCfi);
    }, 200)
  );
  resizeObserver.observe(container);

  rendition.on("selected", async (cfiRange, contents) => {
    const text = book.getRange(cfiRange).toString();
    if (!text || !text.trim()) return;
    await annotations.addUnderline({ range: cfiRange, text, format: "epub" });
    paintUnderline(cfiRange);
    contents.window.getSelection().removeAllRanges();
  });

  // Replay any underlines already saved for this book.
  for (const a of annotations.getCurrentAnnotations()) {
    if (a.type === "underline" && a.format === "epub") paintUnderline(a.range);
  }

  return book;
}

function paintUnderline(cfiRange) {
  rendition.annotations.underline(
    cfiRange,
    {},
    () => {},
    "shelf-underline",
    { stroke: "#f5c542", "stroke-width": "3px", "text-decoration": "underline" }
  );
}

export function removeUnderline(cfiRange) {
  rendition.annotations.remove(cfiRange, "underline");
}

export async function bookmarkCurrentLocation(label) {
  const loc = rendition.currentLocation();
  if (!loc || !loc.start) return;
  await annotations.addBookmark({ position: loc.start.cfi, format: "epub", label });
}

export function goToCfi(cfi) {
  rendition.display(cfi);
}

export function nextPage() {
  rendition.next();
}

export function prevPage() {
  rendition.prev();
}

// Typeface stacks chosen for on-screen reading rather than print fidelity:
// both have generous x-heights and hold up at small sizes on a tablet.
const FONT_STACKS = {
  serif: `"Iowan Old Style", "Charter", "Palatino Linotype", Georgia, serif`,
  sans: `-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
};

let fontFamily = "serif";

function applyTypography() {
  if (!rendition) return;
  rendition.themes.default({
    "body, p, div, span, li": {
      "font-family": `${FONT_STACKS[fontFamily]} !important`,
      "line-height": "1.62 !important",
      "color": "#191512 !important",
      "-webkit-font-smoothing": "antialiased",
      "text-rendering": "optimizeLegibility",
    },
    "p": { "margin-bottom": "0.85em", "hyphens": "auto" },
  });
}

export function setFontFamily(name) {
  fontFamily = FONT_STACKS[name] ? name : "serif";
  applyTypography();
  // Re-display so the new metrics are used for pagination immediately.
  if (rendition && lastCfi) rendition.display(lastCfi);
  return fontFamily;
}

export function getFontFamily() {
  return fontFamily;
}

export function setFontSize(percent) {
  rendition.themes.fontSize(`${percent}%`);
}

export function destroy() {
  if (resizeObserver) resizeObserver.disconnect();
  if (book) book.destroy();
  book = null;
  rendition = null;
  resizeObserver = null;
  lastCfi = null;
}
