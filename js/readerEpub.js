// ============================================================================
// EPUB reader, built on epub.js. Handles rendering, page turns, text
// selection -> underline, bookmarking the current position, and replaying
// saved underlines back onto the page.
// ============================================================================
import * as annotations from "./annotations.js";

let book = null;
let rendition = null;
let onLocationChange = null;
let containerEl = null;
let resizeObserver = null;
let lastCfi = null;

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

export async function openEpub({ container, blob, savedLocation, onLocation }) {
  onLocationChange = onLocation;
  containerEl = container;
  const arrayBuffer = await blob.arrayBuffer();
  book = ePub(arrayBuffer);
  rendition = book.renderTo(container, {
    width: "100%",
    height: "100%",
    spread: "auto", // lets epub.js itself decide single vs. two-column layout by width
    flow: "paginated",
  });

  await rendition.display(savedLocation || undefined);

  rendition.on("relocated", (location) => {
    lastCfi = location.start.cfi;
    if (onLocationChange) onLocationChange(lastCfi, estimateProgress(location));
  });

  // Screen-size adjustment: re-flow columns/pagination whenever the reader's
  // available space changes (rotation, split-screen on iPad, window resize),
  // then jump back to exactly where the reader was.
  resizeObserver = new ResizeObserver(
    debounce(() => {
      rendition.resize(containerEl.clientWidth, containerEl.clientHeight);
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
