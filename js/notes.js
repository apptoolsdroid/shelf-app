// ============================================================================
// The notes canvas: one freeform board per book, for scribbling and pinning
// typed notes — somewhere to work an idea out, rather than mark up a page.
//
// It is a fixed-size board you pan around by scrolling. Everything on it is
// stored normalized to the board, so it renders identically on a phone and a
// tablet, and it lives in the book's own annotation record, which means the
// existing Save button syncs it to OneDrive with everything else.
// ============================================================================
import * as annotations from "./annotations.js";
import { attachInk, renderStrokes, INK_COLORS } from "./ink.js";

// Generous but finite: big enough to spread ideas out, small enough that
// panning never feels lost.
export const BOARD_W = 2400;
export const BOARD_H = 1800;

let boardEl = null;
let svgEl = null;
let notesLayer = null;
let tool = "pen"; // "pen" | "highlighter" | "eraser" | "note"
let color = INK_COLORS[0];
let detach = null;

export function getTool() { return tool; }
export function getColor() { return color; }

export function setTool(t) {
  tool = t;
  if (svgEl) {
    // The ink surface only swallows pointers for drawing tools; with the note
    // tool active, taps need to reach the board to place a note.
    svgEl.style.pointerEvents = t === "note" ? "none" : "auto";
    svgEl.style.touchAction = t === "note" ? "auto" : "none";
  }
}

export function setColor(c) {
  color = c;
}

export function init({ board, svg, notes }) {
  boardEl = board;
  svgEl = svg;
  notesLayer = notes;

  svgEl.setAttribute("viewBox", `0 0 ${BOARD_W} ${BOARD_H}`);

  if (detach) detach();
  detach = attachInk(svgEl, {
    isEnabled: () => tool !== "note",
    getTool: () => tool,
    getColor: () => color,
    onStroke: (stroke) => annotations.addCanvasInk(stroke),
    onErase: (id) => annotations.removeAnnotation(id),
  });

  // Placing a typed note: tap anywhere on the board with the note tool.
  boardEl.addEventListener("click", async (e) => {
    if (tool !== "note") return;
    if (e.target.closest(".canvas-note")) return; // editing an existing one
    const r = boardEl.getBoundingClientRect();
    const x = (e.clientX - r.left + boardEl.scrollLeft) / BOARD_W;
    const y = (e.clientY - r.top + boardEl.scrollTop) / BOARD_H;
    const rec = await annotations.addCanvasNote({ x, y, text: "" });
    render();
    const el = notesLayer.querySelector(`[data-id="${rec.id}"] .canvas-note-text`);
    if (el) el.focus();
  });

  setTool(tool);
}

export function render() {
  if (!svgEl) return;
  const all = annotations.getCurrentAnnotations();

  renderStrokes(svgEl, all.filter((a) => a.type === "canvasInk"), BOARD_W, BOARD_H);

  notesLayer.innerHTML = "";
  for (const n of all.filter((a) => a.type === "canvasNote")) {
    const el = document.createElement("div");
    el.className = "canvas-note";
    el.dataset.id = n.id;
    el.style.left = `${n.x * BOARD_W}px`;
    el.style.top = `${n.y * BOARD_H}px`;
    el.innerHTML = `
      <div class="canvas-note-text" contenteditable="plaintext-only" spellcheck="false"></div>
      <button class="canvas-note-del" title="Delete note" aria-label="Delete note">×</button>
    `;
    const textEl = el.querySelector(".canvas-note-text");
    textEl.textContent = n.text || "";
    textEl.addEventListener("blur", () => annotations.updateCanvasNote(n.id, textEl.textContent.trim()));
    el.querySelector(".canvas-note-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await annotations.removeAnnotation(n.id);
      render();
    });
    notesLayer.appendChild(el);
  }
}

export function isEmpty() {
  return !annotations.getCurrentAnnotations().some(
    (a) => a.type === "canvasInk" || a.type === "canvasNote"
  );
}
