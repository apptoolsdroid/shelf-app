// ============================================================================
// Keyboard shortcuts.
//
// One table, used for three things at once: deciding what a key press does,
// drawing the reference sheet, and labelling buttons with their shortcut. A
// shortcut that exists in the handler but not in the list is a shortcut
// nobody discovers, so there is deliberately only one source for both.
//
// Two rules keep this out of the way:
//   * nothing fires while you're typing in a box, except Escape;
//   * shortcuts are grouped by where you are, so the same key can mean the
//     obvious thing on the shelf and the obvious thing in a book.
// ============================================================================

// Apple keyboards say ⌘ where everyone else says Ctrl. Detected once, from
// the platform rather than the browser string where possible.
export const IS_MAC = (() => {
  try {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    return /mac|iphone|ipad|ipod/i.test(p);
  } catch (_) {
    return false;
  }
})();

const MOD = IS_MAC ? "⌘" : "Ctrl";

// `keys` is what's shown; `match` decides whether an event is this shortcut.
// Writing the match as a function rather than parsing a string keeps the
// awkward cases (Shift+Z, either of two keys) honest.
export const SHORTCUTS = [
  {
    group: "Library",
    items: [
      { keys: ["/"], label: "Search this shelf", id: "search" },
      { keys: [`${MOD}+F`], label: "Search this shelf", id: "search-alt", hide: true },
      { keys: ["S"], label: "Start or finish picking books", id: "select" },
      { keys: [`${MOD}+A`], label: "Select every book shown", id: "select-all" },
      { keys: ["G"], label: "Back to all the bookcases", id: "racks" },
      { keys: ["Y"], label: "Open the sync panel", id: "sync" },
      { keys: ["Esc"], label: "Clear the search, or stop picking", id: "escape" },
    ],
  },
  {
    group: "Reading",
    items: [
      { keys: ["←", "→"], label: "Turn the page", id: "turn" },
      { keys: ["Space"], label: "Turn forward", id: "turn-fwd" },
      { keys: [`${MOD}+U`, `${MOD}+Z`], label: "Undo", id: "undo" },
      { keys: [`${MOD}+⇧+Z`, `${MOD}+Y`], label: "Redo", id: "redo" },
      { keys: [`${MOD}+S`], label: "Save annotations", id: "save" },
      { keys: ["B"], label: "Bookmark this page", id: "bookmark" },
      { keys: ["N"], label: "Open notes", id: "notes" },
      { keys: ["F"], label: "Full page — hide the bars", id: "immersive" },
      { keys: ["Esc"], label: "Bring the bars back, or close the book", id: "escape" },
    ],
  },
  {
    group: "Pen & PDF",
    items: [
      { keys: ["P"], label: "Pen", id: "pen" },
      { keys: ["H"], label: "Highlighter", id: "hilite" },
      { keys: ["E"], label: "Eraser", id: "eraser" },
      { keys: ["1", "2", "3"], label: "Single page, spread, or scroll", id: "viewmode" },
      { keys: ["+", "−"], label: "Zoom in and out", id: "zoom" },
      { keys: ["0"], label: "Fit the page to the screen", id: "zoomreset" },
    ],
  },
  {
    group: "Anywhere",
    items: [
      { keys: ["?"], label: "Show this list", id: "help" },
    ],
  },
];

export function shortcutFor(id) {
  for (const g of SHORTCUTS) {
    const hit = g.items.find((i) => i.id === id);
    if (hit) return hit.keys.join(" or ");
  }
  return "";
}

// True when the key press belongs to whatever the person is typing into, and
// so must be left alone. Escape is the exception: it's how you get out.
export function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  if (e.key === "Escape") return false;
  const tag = (t.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
}

export function hasMod(e) {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}
