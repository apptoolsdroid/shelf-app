// ============================================================================
// Freehand ink: pointer capture, stroke smoothing, SVG rendering and erasing.
//
// Shared by two surfaces — drawing directly on a PDF page, and the notes
// canvas — because the mechanics are identical; only what the coordinates are
// relative to differs.
//
// Every point is stored normalized (0–1) against the surface it was drawn on,
// so ink stays put when the page is zoomed, the window resized or the tablet
// rotated. Absolute pixels would drift the moment anything re-laid out.
// ============================================================================

export const TOOLS = {
  pen: { width: 2.4, opacity: 1, cap: "round", join: "round" },
  highlighter: { width: 16, opacity: 0.3, cap: "butt", join: "round" },
};

export const INK_COLORS = ["#1c1c1c", "#c0392b", "#1f6f4a", "#1d4e89", "#b8860b"];

// Catmull-Rom-ish smoothing: draw through the midpoints of consecutive samples
// with quadratic curves. Raw pointer samples are visibly polygonal otherwise,
// especially on a slow, deliberate highlighting stroke.
export function pointsToPath(points, w, h) {
  if (!points || points.length === 0) return "";
  const px = (p) => (p[0] * w).toFixed(2);
  const py = (p) => (p[1] * h).toFixed(2);
  if (points.length === 1) return `M ${px(points[0])} ${py(points[0])} l 0.01 0`;
  if (points.length === 2) return `M ${px(points[0])} ${py(points[0])} L ${px(points[1])} ${py(points[1])}`;

  let d = `M ${px(points[0])} ${py(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = ((points[i][0] + points[i + 1][0]) / 2) * w;
    const my = ((points[i][1] + points[i + 1][1]) / 2) * h;
    d += ` Q ${px(points[i])} ${py(points[i])} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${px(last)} ${py(last)}`;
  return d;
}

function strokeWidth(stroke) {
  const base = (TOOLS[stroke.tool] || TOOLS.pen).width;
  // Pressure from a stylus varies the weight of the line. Mice and fingers
  // report a constant 0.5, which lands on the base width.
  return base * (0.6 + 0.8 * (stroke.pressure ?? 0.5));
}

export function makePathEl(stroke, w, h) {
  const spec = TOOLS[stroke.tool] || TOOLS.pen;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pointsToPath(stroke.points, w, h));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", stroke.color || "#1c1c1c");
  path.setAttribute("stroke-width", String(strokeWidth(stroke)));
  path.setAttribute("stroke-linecap", spec.cap);
  path.setAttribute("stroke-linejoin", spec.join);
  path.setAttribute("opacity", String(spec.opacity));
  if (stroke.id) path.dataset.id = stroke.id;
  return path;
}

export function renderStrokes(svg, strokes, w, h) {
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  for (const s of strokes) svg.appendChild(makePathEl(s, w, h));
}

// Wires an SVG element up as a drawing surface.
//   isEnabled()  — whether ink is currently the active mode
//   getTool()    — "pen" | "highlighter" | "eraser"
//   getColor()   — stroke colour
//   onStroke(s)  — a finished stroke, points normalized 0–1
//   onErase(id)  — the id of a stroke the eraser passed over
export function attachInk(svg, { isEnabled, getTool, getColor, onStroke, onErase }) {
  let drawing = false;
  let points = [];
  let pressureSum = 0;
  let pressureCount = 0;
  let liveEl = null;
  let sawPen = false;

  const size = () => {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1, left: r.left, top: r.top };
  };

  const norm = (e) => {
    const { w, h, left, top } = size();
    return [
      Math.min(1, Math.max(0, (e.clientX - left) / w)),
      Math.min(1, Math.max(0, (e.clientY - top) / h)),
    ];
  };

  // Palm rejection: once a real stylus has been used on this surface, ignore
  // touch input, which is almost always the side of a hand resting on the
  // screen rather than an intentional finger drawing.
  const accepts = (e) => {
    if (e.pointerType === "pen") { sawPen = true; return true; }
    if (sawPen && e.pointerType === "touch") return false;
    return true;
  };

  const eraseAt = (e) => {
    const pt = svg.createSVGPoint ? null : null;
    for (const path of [...svg.querySelectorAll("path[data-id]")]) {
      const r = path.getBoundingClientRect();
      if (e.clientX < r.left - 6 || e.clientX > r.right + 6) continue;
      if (e.clientY < r.top - 6 || e.clientY > r.bottom + 6) continue;
      onErase && onErase(path.dataset.id);
      path.remove();
    }
  };

  const onDown = (e) => {
    if (!isEnabled() || !accepts(e)) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    // Capture keeps the stroke alive if the pointer leaves the page mid-draw.
    // It is best-effort on purpose: Safari has historically thrown here for
    // SVG targets, and losing capture is far better than losing the stroke.
    try { svg.setPointerCapture(e.pointerId); } catch (_) { /* draw without it */ }

    if (getTool() === "eraser") { drawing = true; eraseAt(e); return; }

    drawing = true;
    points = [norm(e)];
    pressureSum = e.pressure || 0.5;
    pressureCount = 1;

    const { w, h } = size();
    liveEl = makePathEl({ tool: getTool(), color: getColor(), points, pressure: pressureSum }, w, h);
    svg.appendChild(liveEl);
  };

  const onMove = (e) => {
    if (!drawing || !isEnabled()) return;
    e.preventDefault();
    if (getTool() === "eraser") { eraseAt(e); return; }

    // Coalesced events give every sample the hardware captured between frames,
    // which is what makes a fast stroke smooth rather than a chain of chords.
    // The list can come back empty, though, and taking it at face value then
    // silently throws the whole stroke away — so fall back to the event itself.
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [e];
    for (const ev of events) {
      points.push(norm(ev));
      pressureSum += ev.pressure || 0.5;
      pressureCount++;
    }
    const { w, h } = size();
    liveEl.setAttribute("d", pointsToPath(points, w, h));
  };

  const onUp = (e) => {
    if (!drawing) return;
    drawing = false;
    if (getTool() === "eraser") return;
    if (liveEl) liveEl.remove();
    liveEl = null;
    if (points.length < 2) { points = []; return; }

    onStroke && onStroke({
      tool: getTool(),
      color: getColor(),
      points: points.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]),
      pressure: +(pressureSum / Math.max(1, pressureCount)).toFixed(3),
    });
    points = [];
  };

  svg.addEventListener("pointerdown", onDown);
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerup", onUp);
  svg.addEventListener("pointercancel", onUp);
  svg.addEventListener("pointerleave", onUp);

  return () => {
    svg.removeEventListener("pointerdown", onDown);
    svg.removeEventListener("pointermove", onMove);
    svg.removeEventListener("pointerup", onUp);
    svg.removeEventListener("pointercancel", onUp);
    svg.removeEventListener("pointerleave", onUp);
  };
}
