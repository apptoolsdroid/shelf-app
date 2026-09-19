// ============================================================================
// Swipe-to-turn-page handling.
//
// The fiddly part is that this reader also lets you select text to underline
// it. A naive swipe handler steals those drags and makes underlining
// impossible, so a gesture only counts as a page turn when it is clearly a
// flick: mostly horizontal, far enough to be deliberate, quick enough not to
// be a careful selection drag, and with no text actually selected at the end.
// ============================================================================

const MIN_DISTANCE = 45;      // px — shorter than this is a tap or a wobble
const MAX_OFF_AXIS = 0.6;     // vertical travel must stay under 60% of horizontal
const MAX_DURATION = 800;     // ms — a slow drag is selection, not a swipe

export function attachSwipe(target, { onPrev, onNext, isEnabled }) {
  if (!target) return () => {};

  let startX = 0;
  let startY = 0;
  let startT = 0;
  let tracking = false;

  const onStart = (e) => {
    if (e.touches && e.touches.length !== 1) { tracking = false; return; }
    const p = e.touches ? e.touches[0] : e;
    startX = p.clientX;
    startY = p.clientY;
    startT = Date.now();
    tracking = true;
  };

  const onEnd = (e) => {
    if (!tracking) return;
    tracking = false;
    if (isEnabled && !isEnabled()) return;

    const p = (e.changedTouches && e.changedTouches[0]) || e;
    const dx = p.clientX - startX;
    const dy = p.clientY - startY;
    const dt = Date.now() - startT;

    if (dt > MAX_DURATION) return;
    if (Math.abs(dx) < MIN_DISTANCE) return;
    if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS) return;

    // If the user ended up with a selection, they were highlighting text to
    // underline it — turning the page here would throw that away.
    const sel = (target.ownerDocument || document).getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;

    if (dx < 0) onNext && onNext();
    else onPrev && onPrev();
  };

  target.addEventListener("touchstart", onStart, { passive: true });
  target.addEventListener("touchend", onEnd, { passive: true });

  return () => {
    target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchend", onEnd);
  };
}
