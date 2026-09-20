// ============================================================================
// Reflow guard.
//
// Both readers have to re-lay-out when the space they're given changes —
// rotating the tablet, splitting the screen, the toolbar wrapping onto a
// second line. The naive way to do that is to watch the element the pages are
// drawn into and re-render whenever it resizes. That is a feedback loop: the
// render changes the content, the content changes whether a scrollbar is
// needed, the scrollbar changes the element's width, and the observer fires
// again. Each cycle is a full re-render, which on screen reads as the page
// blinking over and over for as long as the book is open.
//
// This module makes that loop impossible three different ways, because any
// one of them alone can be defeated by a browser quirk:
//
//   1. It watches an element the caller chooses — in practice the fixed page
//      area, whose size comes from the window and the toolbar and never from
//      what's rendered inside it.
//   2. It remembers the sizes it has recently reflowed at. A size that comes
//      back around is an oscillation, not a new layout, so it's ignored.
//   3. It caps how often a reflow can happen at all. Past that, it stops and
//      waits for a change big enough (a real rotation) to be worth trusting.
// ============================================================================

const NOISE_PX = 8;          // smaller than this is measurement jitter
const HISTORY = 6;           // sizes remembered for oscillation detection
const BURST_LIMIT = 5;       // reflows allowed...
const BURST_WINDOW_MS = 3000; // ...within this window
const COOLDOWN_MS = 8000;    // silence after a burst
const BIG_CHANGE_PX = 64;    // a change this large breaks a cooldown

function near(a, b) {
  return Math.abs(a.w - b.w) < NOISE_PX && Math.abs(a.h - b.h) < NOISE_PX;
}

/**
 * Watch `target` and call `onChange(size)` when it meaningfully changes.
 *
 * @param {Element} target   Element whose size is the source of truth. Must be
 *                           one the render cannot resize (a fixed page area),
 *                           never the element the pages are drawn into.
 * @param {(size: {w:number,h:number}) => void} onChange
 * @param {{ delay?: number }} [opts]
 * @returns {{ seed: (size:{w:number,h:number}) => void, disconnect: () => void }}
 *          `seed` records the size a render was just done at, so the guard
 *          knows what "unchanged" means without having to guess.
 */
export function watchSize(target, onChange, opts = {}) {
  const delay = opts.delay ?? 150;
  let history = [];      // recent sizes we've reflowed at, newest last
  let stamps = [];       // times of recent reflows
  let cooldownUntil = 0;
  let timer = null;
  let observer = null;

  const current = () => ({ w: target.clientWidth, h: target.clientHeight });

  function seed(size) {
    const s = size || current();
    history.push(s);
    if (history.length > HISTORY) history.shift();
  }

  function consider() {
    const size = current();
    if (!size.w || !size.h) return;                        // hidden; nothing to do
    if (document.visibilityState !== "visible") return;    // backgrounded tab

    const last = history[history.length - 1];
    if (last && near(size, last)) return;                  // nothing actually changed

    const now = Date.now();
    const big = !last || Math.abs(size.w - last.w) >= BIG_CHANGE_PX ||
                Math.abs(size.h - last.h) >= BIG_CHANGE_PX;

    if (now < cooldownUntil && !big) return;

    // Have we been here before? Returning to a size we just left means the
    // layout is flip-flopping between two states, and re-rendering again would
    // only push it back. Settle on what's on screen instead.
    if (!big && history.slice(0, -1).some((h) => near(size, h))) {
      cooldownUntil = now + COOLDOWN_MS;
      return;
    }

    stamps = stamps.filter((t) => now - t < BURST_WINDOW_MS);
    if (stamps.length >= BURST_LIMIT) {
      cooldownUntil = now + COOLDOWN_MS;
      stamps = [];
      return;
    }
    stamps.push(now);

    seed(size);
    onChange(size);
  }

  observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(consider, delay);
  });
  observer.observe(target);

  return {
    seed,
    disconnect() {
      clearTimeout(timer);
      if (observer) observer.disconnect();
      observer = null;
      history = [];
      stamps = [];
    },
  };
}
