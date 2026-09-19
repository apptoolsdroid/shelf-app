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
  await render();
}

function attachResizeHandling() {
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver(debounce(() => render(), 150));
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

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
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

  const underlineLayer = document.createElement("div");
  underlineLayer.className = "underline-layer";
  Object.assign(underlineLayer.style, { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" });
  wrapper.appendChild(underlineLayer);

  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

  const textContent = await page.getTextContent();
  pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport, textDivs: [] });

  const handler = () => handleSelection(pageNum, viewport, wrapper);
  textLayerDiv.addEventListener("mouseup", handler);
  textLayerDiv.addEventListener("touchend", handler);

  drawSavedUnderlines(underlineLayer, viewport, pageNum);

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

function drawSavedUnderlines(layerEl, viewport, pageNum) {
  for (const a of annotations.getCurrentAnnotations()) {
    if (a.type === "underline" && a.format === "pdf" && a.range.page === pageNum) {
      paintUnderlineRects(layerEl, a.range.rects, viewport);
    }
  }
}

// ---- Top-level render dispatch ---------------------------------------------

async function render() {
  if (!pdfDoc) return;
  if (viewMode === "scroll") await renderScrollView();
  else await renderPagedView();
  notifyState();
}

async function renderPagedView() {
  const pages = viewMode === "double" ? getSpreadPages(currentPage) : [currentPage];
  currentPage = pages[0];
  const scale = currentScale(pages.length);

  containerEl.style.alignItems = "center";
  containerEl.innerHTML = "";
  const stage = document.createElement("div");
  stage.className = "pdf-stage";
  Object.assign(stage.style, { display: "flex", gap: "12px", margin: "auto" });
  containerEl.appendChild(stage);

  for (const p of pages) {
    stage.appendChild(await buildPageEl(p, scale));
  }
}

async function renderScrollView() {
  containerEl.style.alignItems = "flex-start";
  containerEl.innerHTML = "";
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
  containerEl.appendChild(scrollWrap);

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
