// ============================================================================
// PDF reader, built on pdf.js. Supports three view modes — single page,
// two-page "book" spread, and continuous scroll — plus fit-to-screen sizing
// that recomputes on rotation/resize, a zoom multiplier on top of that fit,
// and remembers the last page, view mode, and zoom per book.
//
// Underline positions are stored as normalized rectangles per page, so they
// stay correct no matter what zoom level or screen size they're viewed at.
// ============================================================================
import * as annotations from "./annotations.js";
import { attachSwipe } from "./gestures.js";
import { attachInk, renderStrokes } from "./ink.js";

// pdf.js v4 ships as an ES module only — loading it with a plain <script> tag
// silently leaves pdfjsLib undefined and every PDF fails to open. Import it
// properly here, and point it at its worker relative to this file so it keeps
// working when the app is hosted in a subfolder (e.g. GitHub Pages project
// sites). If the module worker can't start, pdf.js falls back to rendering on
// the main thread — slower, but it still opens the book.
import * as pdfjsLib from "./vendor/pdf.min.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.js", import.meta.url).href;

let pdfDoc = null;
let currentPage = 1;
let viewMode = "single"; // "single" | "double" | "scroll"
let zoomFactor = 1; // multiplier on top of the computed fit scale
let baseViewport1x = null; // page 1's viewport at scale 1, used to compute fit
let containerEl = null;
let onStateChange = null;
let resizeObserver = null;
let scrollObserver = null;
let detachSwipe = null;

// Ink mode: while it's on, the page is a drawing surface instead of something
// you select text on or swipe to turn.
let inkMode = false;       // false when off, otherwise the active tool name
let inkColor = "#c0392b";
export function setInkTool(tool) { inkMode = tool; refreshInkLayers(); }
export function getInkTool() { return inkMode; }
export function setInkColor(c) { inkColor = c; }
export function isInking() { return !!inkMode; }

// The text layer has to stop intercepting pointers while drawing, or every
// stroke turns into a text selection instead.
function refreshInkLayers() {
  if (!containerEl) return;
  for (const svg of containerEl.querySelectorAll(".ink-layer")) {
    svg.style.pointerEvents = inkMode ? "auto" : "none";
    svg.style.touchAction = inkMode ? "none" : "auto";
  }
  for (const tl of containerEl.querySelectorAll(".textLayer")) {
    tl.style.pointerEvents = inkMode ? "none" : "auto";
  }
}
const renderedScrollPages = new Set();

export async function openPdf({ container, blob, savedState, onState }) {
  containerEl = container;
  onStateChange = onState;
  const arrayBuffer = await blob.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const first = await pdfDoc.getPage(1);
  baseViewport1x = first.getViewport({ scale: 1 });

  currentPage = savedState?.page && savedState.page <= pdfDoc.numPages ? savedState.page : 1;
  viewMode = savedState?.viewMode || "single";
  zoomFactor = savedState?.zoomFactor || 1;

  attachResizeHandling();
  // Swipe to turn pages. Disabled in continuous-scroll mode, where a
  // horizontal flick has no meaning and the gesture belongs to the scroller.
  if (detachSwipe) detachSwipe();
  detachSwipe = attachSwipe(containerEl, {
    onPrev: () => prevPage(),
    onNext: () => nextPage(),
    isEnabled: () => viewMode !== "scroll" && !inkMode,
  });
  await render();
}

// Remembers the size the current pages were built for. iOS in particular
// fires resize notifications that don't actually change anything, and
// re-rendering for those is what made the page blink while a book loaded.
let renderedForSize = { w: 0, h: 0 };

function attachResizeHandling() {
  if (resizeObserver) resizeObserver.disconnect();
  renderedForSize = { w: 0, h: 0 };
  resizeObserver = new ResizeObserver(
    debounce(() => {
      const w = containerEl.clientWidth;
      const h = containerEl.clientHeight;
      // A couple of pixels of drift is noise, not a rotation.
      if (Math.abs(w - renderedForSize.w) < 4 && Math.abs(h - renderedForSize.h) < 4) return;
      render();
    }, 150)
  );
  resizeObserver.observe(containerEl);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- Fit-to-screen scale calculation ---------------------------------------

function computeFitScale(pagesAcross) {
  const availW = containerEl.clientWidth - 24; // small margin
  const availH = containerEl.clientHeight - 24;
  const gap = pagesAcross === 2 ? 12 : 0;
  const byWidth = (availW - gap) / (pagesAcross * baseViewport1x.width);
  const byHeight = availH / baseViewport1x.height;
  return Math.max(0.3, Math.min(byWidth, byHeight));
}

function currentScale(pagesAcross) {
  return computeFitScale(pagesAcross) * zoomFactor;
}

// ---- Book-style spread pairing ---------------------------------------------
// Page 1 is a solo "cover"; after that, pages pair up (2,3), (4,5), ...
function getSpreadPages(anchorPage) {
  if (anchorPage <= 1) return [1];
  const pairIndex = Math.floor((anchorPage - 2) / 2);
  const left = 2 + pairIndex * 2;
  const pages = [left];
  if (left + 1 <= pdfDoc.numPages) pages.push(left + 1);
  return pages;
}

// ---- Rendering a single page's canvas + text layer + underline layer -------

async function buildPageEl(pageNum, scale) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const wrapper = document.createElement("div");
  wrapper.className = "pdf-page-wrapper";
  wrapper.dataset.page = String(pageNum);
  Object.assign(wrapper.style, { position: "relative", width: `${viewport.width}px`, height: `${viewport.height}px`, flexShrink: "0" });

  // Render at the screen's real pixel density. A canvas sized only in CSS
  // pixels is drawn at 1x and then stretched by the display, which is exactly
  // what makes PDF text look soft and smeary on a Retina iPad. Capped at 2x
  // because the memory cost grows with the square of this and the visible
  // gain above 2x is negligible.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  wrapper.appendChild(canvas);

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  Object.assign(textLayerDiv.style, {
    position: "absolute", left: 0, top: 0, right: 0, bottom: 0,
    lineHeight: "1", userSelect: "text",
  });
  // pdf.js's text layer positions/sizes every span via calc() expressions
  // that read this custom property — without it, selectable text renders at
  // the wrong size and drifts out of alignment with the page underneath it.
  // (Text itself stays invisible via the `.textLayer span { color: transparent }`
  // rule in style.css — this layer exists only to make the page selectable.)
  textLayerDiv.style.setProperty("--scale-factor", String(scale));
  wrapper.appendChild(textLayerDiv);

  // Drawing surface for this page, sized to the page so normalized stroke
  // coordinates map straight onto it at any zoom level.
  const inkLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  inkLayer.setAttribute("class", "ink-layer");
  inkLayer.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  Object.assign(inkLayer.style, {
    position: "absolute", left: 0, top: 0,
    width: `${viewport.width}px`, height: `${viewport.height}px`,
    pointerEvents: inkMode ? "auto" : "none",
    touchAction: inkMode ? "none" : "auto",
  });
  wrapper.appendChild(inkLayer);

  const underlineLayer = document.createElement("div");
  underlineLayer.className = "underline-layer";
  Object.assign(underlineLayer.style, { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" });
  wrapper.appendChild(underlineLayer);

  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    // Scales the drawing up to match the enlarged backing store above, so the
    // page is rendered at full device resolution rather than resampled.
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  }).promise;

  const textContent = await page.getTextContent();
  pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport, textDivs: [] });

  const handler = () => handleSelection(pageNum, viewport, wrapper);
  textLayerDiv.addEventListener("mouseup", handler);
  textLayerDiv.addEventListener("touchend", handler);

  drawSavedUnderlines(underlineLayer, viewport, pageNum);
  drawSavedInk(inkLayer, viewport.width, viewport.height, pageNum);

  attachInk(inkLayer, {
    isEnabled: () => !!inkMode,
    getTool: () => inkMode,
    getColor: () => inkColor,
    // Saving triggers an annotations change, and refreshInk() redraws this
    // layer from the record — appending the stroke here as well would paint
    // every line twice, which shows up as double-dark highlighter.
    onStroke: (stroke) => annotations.addInk({ page: pageNum, format: "pdf", ...stroke }),
    onErase: (id) => annotations.removeAnnotation(id),
  });

  return wrapper;
}

async function handleSelection(pageNum, viewport, wrapper) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const range = sel.getRangeAt(0);
  const rects = Array.from(range.getClientRects());
  if (rects.length === 0) return;

  const containerRect = wrapper.getBoundingClientRect();
  const normalizedRects = rects.map((r) => ({
    x: (r.left - containerRect.left) / viewport.width,
    y: (r.top - containerRect.top) / viewport.height,
    w: r.width / viewport.width,
    h: r.height / viewport.height,
  }));

  const text = sel.toString();
  await annotations.addUnderline({ format: "pdf", range: { page: pageNum, rects: normalizedRects }, text });

  paintUnderlineRects(wrapper.querySelector(".underline-layer"), normalizedRects, viewport);
  sel.removeAllRanges();
}

function paintUnderlineRects(layerEl, normalizedRects, viewport) {
  for (const r of normalizedRects) {
    const div = document.createElement("div");
    Object.assign(div.style, {
      position: "absolute",
      left: `${r.x * viewport.width}px`,
      top: `${(r.y + r.h) * viewport.height - 2}px`,
      width: `${r.w * viewport.width}px`,
      height: "3px",
      background: "#f5c542",
    });
    layerEl.appendChild(div);
  }
}

function drawSavedInk(svgEl, w, h, pageNum) {
  const strokes = annotations.getCurrentAnnotations()
    .filter((a) => a.type === "ink" && a.format === "pdf" && a.page === pageNum);
  renderStrokes(svgEl, strokes, w, h);
}

// Redraws every visible page's ink from the annotation record. Undo and redo
// change that record, and without this the strokes on screen would drift out
// of step with what's actually saved.
export function refreshInk() {
  if (!containerEl) return;
  for (const wrapper of containerEl.querySelectorAll(".pdf-page-wrapper")) {
    const svg = wrapper.querySelector(".ink-layer");
    const pageNum = Number(wrapper.dataset.page);
    if (!svg || !pageNum) continue;
    drawSavedInk(svg, parseFloat(svg.style.width), parseFloat(svg.style.height), pageNum);
  }
  refreshInkLayers();
}

function drawSavedUnderlines(layerEl, viewport, pageNum) {
  for (const a of annotations.getCurrentAnnotations()) {
    if (a.type === "underline" && a.format === "pdf" && a.range.page === pageNum) {
      paintUnderlineRects(layerEl, a.range.rects, viewport);
    }
  }
}

// ---- Top-level render dispatch ---------------------------------------------

let renderToken = 0;

async function render() {
  if (!pdfDoc) return;
  renderedForSize = { w: containerEl.clientWidth, h: containerEl.clientHeight };
  if (viewMode === "scroll") await renderScrollView();
  else await renderPagedView();
  notifyState();
}

async function renderPagedView() {
  const myToken = ++renderToken;
  const pages = viewMode === "double" ? getSpreadPages(currentPage) : [currentPage];
  currentPage = pages[0];
  const scale = currentScale(pages.length);

  // Built detached from the document, so the reader keeps showing the page it
  // already has until the new one is completely ready. Clearing first and
  // filling afterwards is what produced a blank flash on every redraw —
  // barely visible on a fast screen, very visible on a Retina tablet where
  // each canvas is four times the pixels.
  const stage = document.createElement("div");
  stage.className = "pdf-stage";
  Object.assign(stage.style, { display: "flex", gap: "12px", margin: "auto" });

  for (const p of pages) {
    stage.appendChild(await buildPageEl(p, scale));
    if (myToken !== renderToken) return; // a newer render started; drop this one
  }

  if (myToken !== renderToken) return;
  containerEl.style.alignItems = "center";
  containerEl.replaceChildren(stage);
}

async function renderScrollView() {
  const myToken = ++renderToken;
  renderedScrollPages.clear();
  const scale = currentScale(1);
  const scrollWrap = document.createElement("div");
  scrollWrap.className = "pdf-scroll";
  Object.assign(scrollWrap.style, { display: "flex", flexDirection: "column", gap: "10px", width: "100%", alignItems: "center" });

  // Placeholder for every page, sized from page 1's viewport (fast path,
  // fine for the vast majority of PDFs where every page is the same size).
  const estW = baseViewport1x.width * scale;
  const estH = baseViewport1x.height * scale;
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const ph = document.createElement("div");
    ph.className = "pdf-placeholder";
    ph.dataset.page = String(p);
    Object.assign(ph.style, { width: `${estW}px`, height: `${estH}px`, flexShrink: "0" });
    scrollWrap.appendChild(ph);
  }
  if (myToken !== renderToken) return;
  containerEl.style.alignItems = "flex-start";
  containerEl.replaceChildren(scrollWrap);

  if (scrollObserver) scrollObserver.disconnect();
  scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const p = Number(entry.target.dataset.page);
        if (entry.isIntersecting && !renderedScrollPages.has(p)) {
          renderedScrollPages.add(p);
          buildPageEl(p, scale).then((el) => entry.target.replaceWith(el));
        }
        // Track roughly which page is centered in view, for "remember last page".
        if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
          currentPage = p;
          notifyState();
        }
      }
    },
    { root: containerEl, rootMargin: "800px 0px", threshold: [0, 0.5, 1] }
  );
  scrollWrap.querySelectorAll(".pdf-placeholder, .pdf-page-wrapper").forEach((el) => scrollObserver.observe(el));

  // Jump to the remembered page on open.
  requestAnimationFrame(() => {
    const target = scrollWrap.children[Math.max(0, currentPage - 1)];
    if (target) target.scrollIntoView({ block: "start" });
  });
}

function notifyState() {
  if (onStateChange) {
    onStateChange({ page: currentPage, viewMode, zoomFactor, numPages: pdfDoc.numPages });
  }
}

// ---- Public controls ---------------------------------------------------

export async function bookmarkCurrentPage(label) {
  await annotations.addBookmark({ position: { page: currentPage }, format: "pdf", label });
}

export function nextPage() {
  if (viewMode === "scroll") return;
  const step = viewMode === "double" ? getSpreadPages(currentPage).length || 2 : 1;
  currentPage = Math.min(currentPage + Math.max(step, 1), pdfDoc.numPages);
  return render();
}

export function prevPage() {
  if (viewMode === "scroll") return;
  if (viewMode === "double") {
    const pages = getSpreadPages(currentPage);
    const prevAnchor = Math.max(1, pages[0] - 1);
    currentPage = prevAnchor;
  } else {
    currentPage = Math.max(1, currentPage - 1);
  }
  return render();
}

export function setViewMode(mode) {
  viewMode = mode;
  return render();
}

export function getViewMode() {
  return viewMode;
}

export function setZoom(factor) {
  zoomFactor = Math.max(0.5, Math.min(3, factor));
  return render();
}

export function resetZoomToFit() {
  zoomFactor = 1;
  return render();
}

export function getZoomFactor() {
  return zoomFactor;
}

export function getPageInfo() {
  return { currentPage, numPages: pdfDoc ? pdfDoc.numPages : 0 };
}

export function destroy() {
  if (resizeObserver) resizeObserver.disconnect();
  if (scrollObserver) scrollObserver.disconnect();
  pdfDoc = null;
  if (containerEl) containerEl.innerHTML = "";
}


// How many pages a PDF has, without opening it in the reader. Used to show a
// page count on the cover for books you haven't read yet.
export async function getPageCount(blob) {
  try {
    const doc = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const n = doc.numPages;
    doc.destroy();
    return n;
  } catch (_) {
    return null; // a damaged or encrypted file just gets no page count
  }
}
