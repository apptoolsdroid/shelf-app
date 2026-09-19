// ============================================================================
// App orchestrator: wires the bookshelf (a rail of category "shelves" plus
// the books inside whichever one is open), sign-in, sync, and the reader
// (EPUB or PDF) together, and drives the toolbar (undo/redo/bookmark/save).
// ============================================================================
import { APP_VERSION } from "./version.js";
import { initAuth, isSignedIn, signIn, signOut, getAccount } from "./msalAuth.js";
import * as shelf from "./bookshelf.js";
import * as annotations from "./annotations.js";
import * as epubReader from "./readerEpub.js";
import * as pdfReader from "./readerPdf.js";

const el = (id) => document.getElementById(id);
const shelfView = el("shelfView");
const readerView = el("readerView");
const toastEl = el("toast");

let currentBookMeta = null;
let currentFormat = null; // "epub" | "pdf"
let expandedShelfId = null; // which rail tab is currently open
let openMenuEl = null; // the "add to shelf" popover, if one is open

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

// ---- Auth --------------------------------------------------------------

async function refreshSignInUI() {
  const btn = el("signInBtn");
  const dot = el("statusDot");
  if (isSignedIn()) {
    const acc = getAccount();
    btn.textContent = `Sign out (${(acc.username || "").split("@")[0]})`;
    dot.classList.add("online");
  } else {
    btn.textContent = "Sign in";
    dot.classList.remove("online");
  }
}

el("signInBtn").addEventListener("click", async () => {
  try {
    if (isSignedIn()) {
      signOut();
    } else {
      await signIn();
      toast("Signed in to Microsoft");
    }
  } catch (err) {
    toast(err.message);
  }
  await refreshSignInUI();
});

// ---- Bookshelf: rail of shelves + the open shelf's panel --------------------

el("syncBtn").addEventListener("click", async () => {
  if (!isSignedIn()) {
    toast("Sign in to Microsoft first.");
    return;
  }
  toast("Syncing with OneDrive...");
  try {
    const result = await shelf.syncFromOneDrive();
    toast(`Synced ${result.count} book(s) from OneDrive`);
    await renderLibrary();
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  }
});

el("localFileInput").addEventListener("change", async (e) => {
  let added = 0;
  let skipped = 0;
  for (const file of e.target.files) {
    const result = await shelf.importLocalFile(file);
    if (result.duplicate) skipped++;
    else added++;
  }
  if (added && skipped) toast(`Added ${added}, skipped ${skipped} already on your shelf`);
  else if (added) toast(added === 1 ? "Added to your shelf" : `Added ${added} books`);
  else if (skipped) toast(skipped === 1 ? "Already on your shelf" : `All ${skipped} already on your shelf`);
  await renderLibrary();
  e.target.value = "";
});

// Fetches the current shelves and (re)draws the rail + open panel. Call this
// whenever the underlying data changed (import, sync, shelf create/delete,
// a book added to/removed from a shelf).
async function renderLibrary() {
  const shelves = await shelf.listAllShelves();
  if (!expandedShelfId || !shelves.some((s) => s.id === expandedShelfId)) {
    const continueReading = shelves.find((s) => s.id === "smart:continue");
    expandedShelfId = (continueReading && continueReading.books.length > 0)
      ? continueReading.id
      : (shelves[0] ? shelves[0].id : null);
  }
  renderRail(shelves);
  renderPanel(shelves);
}

function renderRail(shelves) {
  const rail = el("shelfRail");
  rail.innerHTML = "";
  for (const s of shelves) {
    const tab = document.createElement("div");
    tab.className = "shelf-tab" + (s.id === expandedShelfId ? " active" : "");
    tab.innerHTML = `
      <span class="tab-chevron">${s.id === expandedShelfId ? "▾" : "▸"}</span>
      <span>${escapeHtml(s.name)}</span>
      <span class="tab-count">${s.books.length}</span>
    `;
    tab.addEventListener("click", () => {
      expandedShelfId = expandedShelfId === s.id ? null : s.id;
      renderLibrary();
    });
    rail.appendChild(tab);
  }

  const newTab = document.createElement("div");
  newTab.className = "shelf-tab-new";
  newTab.title = "New shelf";
  newTab.textContent = "+";
  newTab.addEventListener("click", () => startNewShelfInput(rail, newTab));
  rail.appendChild(newTab);
}

function startNewShelfInput(rail, newTabEl, onCreated) {
  const input = document.createElement("input");
  input.className = "new-shelf-input";
  input.placeholder = "Shelf name";
  newTabEl.replaceWith(input);
  input.focus();

  let settled = false;
  const finish = async () => {
    if (settled) return; // Enter triggers this, then removing the input on
    settled = true;       // re-render fires blur too — only run it once.
    const name = input.value.trim();
    if (name) {
      const id = await shelf.createCustomShelf(name);
      expandedShelfId = id;
      await renderLibrary();
      if (onCreated) onCreated(id);
    } else {
      renderLibrary();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish();
    if (e.key === "Escape") { settled = true; renderLibrary(); }
  });
  input.addEventListener("blur", finish);
}

function renderPanel(shelves) {
  const panel = el("shelfPanel");
  const active = shelves.find((s) => s.id === expandedShelfId);

  if (!active) {
    panel.innerHTML = `<div class="empty-state" id="emptyState">
      No books yet. Sign in and tap <strong>Sync OneDrive</strong> to pull everything from your
      OneDrive <em>Books</em> folder, or use <strong>Import file</strong> to add an EPUB/PDF from this device.
    </div>`;
    return;
  }

  const sections = shelf.groupByFormat(active.books);
  const header = `
    <div class="shelf-panel-header">
      <h2>${escapeHtml(active.name)}</h2>
      <span class="book-sub">${active.books.length} book${active.books.length === 1 ? "" : "s"}</span>
      ${active.kind === "custom" ? `<button class="shelf-delete-btn" id="deleteShelfBtn">Delete shelf</button>` : ""}
    </div>
  `;

  if (sections.length === 0) {
    panel.innerHTML = header + `<div class="empty-state">Nothing on this shelf yet.</div>`;
  } else {
    panel.innerHTML = header + sections.map((sec) => `
      <div class="shelf-section">
        <h3>${escapeHtml(sec.label)}</h3>
        <div class="shelf-row">
          <div class="grid" data-section="${escapeHtml(sec.label)}"></div>
          <div class="shelf-board" aria-hidden="true"></div>
        </div>
      </div>
    `).join("");
    for (const sec of sections) {
      const gridEl = panel.querySelector(`.grid[data-section="${CSS.escape(sec.label)}"]`);
      for (const book of sec.books) gridEl.appendChild(renderBookCard(book));
    }
  }

  const delBtn = el("deleteShelfBtn");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      await shelf.deleteCustomShelf(active.id);
      expandedShelfId = null;
      await renderLibrary();
    });
  }
}

function renderBookCard(book) {
  const card = document.createElement("div");
  card.className = "book-card";
  card.dataset.bookId = book.id;
  // The title is printed on the cover itself, so there's deliberately no
  // caption underneath — that also lets the book sit directly on the shelf
  // board instead of floating above it.
  const pct = Math.round((book.progress || 0) * 100);
  card.innerHTML = `
    <button class="card-menu-btn" title="Book options" aria-label="Book options">⋯</button>
    <div class="book-cover" title="${escapeHtml(book.title)}">
      <span class="fmt-badge">${book.format}</span>
      <span class="cover-title">${escapeHtml(book.title)}</span>
      ${book.source === "onedrive" ? `<span class="cloud-badge" title="From OneDrive">☁</span>` : ""}
      ${pct > 0 ? `<span class="cover-progress" title="${pct}% read"><i style="width:${pct}%"></i></span>` : ""}
    </div>
  `;
  card.querySelector(".card-menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleShelfMenu(book, e.currentTarget);
  });
  card.addEventListener("click", () => openBook(book, card.querySelector(".book-cover")));
  return card;
}

// ---- "Add to shelf" popover --------------------------------------------------

// The outside-click listener runs on the CAPTURE phase, so it fires before the
// menu's own click handler — without this guard it tears the menu down on the
// very first tap inside it, which breaks any multi-step interaction (such as
// the tap-again-to-confirm delete).
function onDocumentClickForMenu(e) {
  if (openMenuEl && openMenuEl.contains(e.target)) return;
  closeShelfMenu();
}

function closeShelfMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
    document.removeEventListener("click", onDocumentClickForMenu, true);
  }
}

async function toggleShelfMenu(book, anchorBtn) {
  if (openMenuEl) {
    closeShelfMenu();
    return;
  }
  const customShelves = await shelf.getCustomShelfRecords();
  const menu = document.createElement("div");
  menu.className = "shelf-menu";
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;

  const shelfItems = customShelves.map((s) => `
    <div class="shelf-menu-item" data-shelf-id="${s.id}">
      <span class="check">${s.bookIds.includes(book.id) ? "✓" : ""}</span>${escapeHtml(s.name)}
    </div>
  `).join("");
  menu.innerHTML =
    `<div class="shelf-menu-label">Categories</div>` +
    shelfItems +
    `<div class="shelf-menu-item" data-action="new"><span class="check">＋</span>New category…</div>` +
    `<div class="shelf-menu-sep"></div>` +
    `<div class="shelf-menu-item danger" data-action="delete"><span class="check">🗑</span>Remove book</div>`;

  menu.addEventListener("click", async (e) => {
    e.stopPropagation();
    const item = e.target.closest(".shelf-menu-item");
    if (!item) return;
    if (item.dataset.action === "delete") {
      // Deliberately a two-step confirm: this erases the file and any
      // underlines/bookmarks from the device, and there's no undo for it.
      if (item.dataset.confirm !== "1") {
        item.dataset.confirm = "1";
        item.innerHTML = `<span class="check">🗑</span>Tap again to confirm`;
        return;
      }
      closeShelfMenu();
      await shelf.removeBook(book.id);
      toast(`Removed "${book.title}"`);
      await renderLibrary();
      return;
    }
    if (item.dataset.action === "new") {
      const placeholderTab = document.createElement("div");
      menu.replaceChildren(placeholderTab);
      startNewShelfInput(menu, placeholderTab, async (newShelfId) => {
        await shelf.toggleBookInCustomShelf(newShelfId, book.id);
        await renderLibrary();
      });
      return;
    }
    await shelf.toggleBookInCustomShelf(item.dataset.shelfId, book.id);
    closeShelfMenu();
    await renderLibrary();
  });

  document.body.appendChild(menu);
  openMenuEl = menu;
  setTimeout(() => document.addEventListener("click", onDocumentClickForMenu, true), 0);
}

// ---- Reader ----------------------------------------------------------------

function setPdfControlsVisible(visible) {
  document.querySelectorAll(".pdf-only").forEach((elm) => elm.classList.toggle("hidden", !visible));
  el("pdfViewModeSelect").classList.toggle("hidden", !visible);
  el("fontMinusBtn").classList.toggle("hidden", visible);
  el("fontPlusBtn").classList.toggle("hidden", visible);
}

// Synchronous DOM swap only (no awaits) — this is what the View Transition
// animates between "old" (the shelf, with the clicked cover) and "new" (this
// shell, with the morph surface standing in for the not-yet-loaded page).
function showReaderShell(meta) {
  currentBookMeta = meta;
  currentFormat = meta.format;
  el("titleText").textContent = meta.title;

  shelfView.classList.add("hidden");
  readerView.classList.add("active");
  el("epubContainer").classList.add("hidden");
  el("pdfContainer").classList.add("hidden");
  el("epubContainer").innerHTML = "";
  el("pdfContainer").innerHTML = "";
  setPdfControlsVisible(currentFormat === "pdf");
  el("pageInfo").textContent = "";

  const morph = el("readerMorphSurface");
  el("readerMorphText").textContent = meta.title;
  el("morphBackBtn").hidden = true;
  morph.classList.remove("hidden");
}

async function openBook(meta, coverEl) {
  closeShelfMenu();
  const morph = el("readerMorphSurface");

  if (document.startViewTransition && coverEl) {
    coverEl.style.viewTransitionName = "book-morph";
    morph.style.viewTransitionName = "book-morph";
    const transition = document.startViewTransition(() => showReaderShell(meta));
    transition.finished.finally(() => {
      coverEl.style.viewTransitionName = "";
      morph.style.viewTransitionName = "";
    });
    try { await transition.ready; } catch (_) { /* animation may be skipped; fine */ }
  } else {
    showReaderShell(meta);
  }

  await loadBookContent(meta);
}

async function loadBookContent(meta) {
  await annotations.loadForBook(meta.id);
  await annotations.reconcileWithOneDrive(meta);

  // Un-hide the real container *before* handing it to epub.js/pdf.js. Both
  // measure the container's live size the moment they start, and bake that
  // measurement in — if it's still display:none (0×0) at that instant, the
  // page renders permanently blank even after the container is later shown.
  // The morph placeholder stays visually on top (z-index) until content is
  // actually ready, so this doesn't cause a flash of empty page.
  const containerEl = el(currentFormat === "epub" ? "epubContainer" : "pdfContainer");
  containerEl.classList.remove("hidden");

  try {
    const blob = await shelf.ensureBookBytes(meta);

    if (currentFormat === "epub") {
      await epubReader.openEpub({
        container: containerEl,
        blob,
        savedLocation: meta.lastLocation,
        onLocation: (cfi, progress) => shelf.saveLastLocation(meta.id, cfi, progress),
      });
    } else {
      const saved = meta.lastLocation || {};
      el("pdfViewModeSelect").value = saved.viewMode || "single";
      await pdfReader.openPdf({
        container: containerEl,
        blob,
        savedState: { page: saved.page, viewMode: saved.viewMode, zoomFactor: saved.zoomFactor },
        onState: (state) => {
          shelf.saveLastLocation(meta.id, state);
          updatePageInfo(state);
        },
      });
    }
    el("readerMorphSurface").classList.add("hidden");
  } catch (err) {
    console.error("Failed to open book:", err);
    toast(`Couldn't open book: ${err.message}`);
    // Say what went wrong and always offer a way out — the toolbar's back
    // button is still there, but an explicit escape here means a failed book
    // can never feel like a dead end.
    el("readerMorphText").textContent = `Couldn't open "${meta.title}" — ${err.message}`;
    el("morphBackBtn").hidden = false;
  }
}

function updatePageInfo(pdfState) {
  if (currentFormat !== "pdf") {
    el("pageInfo").textContent = "";
    return;
  }
  const state = pdfState || pdfReader.getPageInfo();
  el("pageInfo").textContent = `Page ${state.page ?? state.currentPage} / ${state.numPages}`;
}

async function closeBook() {
  if (annotations.isDirty() && isSignedIn()) {
    await annotations.saveToOneDrive(currentBookMeta).catch(() => {});
  }
  const closedBookId = currentBookMeta ? currentBookMeta.id : null;
  if (currentFormat === "epub") epubReader.destroy();
  if (currentFormat === "pdf") pdfReader.destroy();

  const shelves = await shelf.listAllShelves();

  const runShellSwap = () => {
    if (!expandedShelfId || !shelves.some((s) => s.id === expandedShelfId)) {
      expandedShelfId = shelves[0] ? shelves[0].id : null;
    }
    renderRail(shelves);
    renderPanel(shelves);
    readerView.classList.remove("active");
    shelfView.classList.remove("hidden");
    el("titleText").textContent = "Shelf";
  };

  if (document.startViewTransition) {
    el("readerMorphSurface").classList.remove("hidden");
    el("readerMorphSurface").style.viewTransitionName = "book-morph";
    const transition = document.startViewTransition(runShellSwap);
    await transition.finished.catch(() => {});
    el("readerMorphSurface").style.viewTransitionName = "";
    el("readerMorphSurface").classList.add("hidden");
    const newCard = closedBookId ? document.querySelector(`.book-card[data-book-id="${closedBookId}"]`) : null;
    if (newCard) newCard.style.viewTransitionName = "";
  } else {
    runShellSwap();
  }
}

el("backBtn").addEventListener("click", closeBook);
el("morphBackBtn").addEventListener("click", closeBook);

// Without these, a thrown error anywhere leaves the app looking simply dead —
// nothing happens when you tap, and there's no clue why. Surfacing it as a
// toast turns a silent failure into something reportable.
window.addEventListener("error", (e) => {
  toast(`Error: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  toast(`Error: ${reason}`);
});

// PDF page navigation via tapping left/right thirds of the container
// (only meaningful in single/double page mode — scroll mode is scrolled).
el("pdfContainer") && el("pdfContainer").addEventListener("click", (e) => {
  if (currentFormat !== "pdf" || pdfReader.getViewMode() === "scroll") return;
  const rect = el("pdfContainer").getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width * 0.25) pdfReader.prevPage();
  else if (x > rect.width * 0.75) pdfReader.nextPage();
});

el("prevArrowBtn").addEventListener("click", () => pdfReader.prevPage());
el("nextArrowBtn").addEventListener("click", () => pdfReader.nextPage());

el("pdfViewModeSelect").addEventListener("change", (e) => {
  pdfReader.setViewMode(e.target.value);
});

el("zoomOutBtn").addEventListener("click", () => pdfReader.setZoom(pdfReader.getZoomFactor() - 0.15));
el("zoomInBtn").addEventListener("click", () => pdfReader.setZoom(pdfReader.getZoomFactor() + 0.15));
el("zoomFitBtn").addEventListener("click", () => pdfReader.resetZoomToFit());

el("epubContainer") && el("epubContainer").addEventListener("click", (e) => {
  if (currentFormat !== "epub") return;
  const rect = el("epubContainer").getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width * 0.2) epubReader.prevPage();
  else if (x > rect.width * 0.8) epubReader.nextPage();
});

// ---- Toolbar: undo / redo / bookmark / font / save --------------------------

el("undoBtn").addEventListener("click", () => annotations.undo());
el("redoBtn").addEventListener("click", () => annotations.redo());

el("bookmarkBtn").addEventListener("click", async () => {
  if (currentFormat === "epub") await epubReader.bookmarkCurrentLocation();
  else await pdfReader.bookmarkCurrentPage();
  toast("Bookmarked");
});

let fontPct = 100;
el("fontPlusBtn").addEventListener("click", () => {
  if (currentFormat !== "epub") return;
  fontPct = Math.min(200, fontPct + 10);
  epubReader.setFontSize(fontPct);
});
el("fontMinusBtn").addEventListener("click", () => {
  if (currentFormat !== "epub") return;
  fontPct = Math.max(60, fontPct - 10);
  epubReader.setFontSize(fontPct);
});

el("saveBtn").addEventListener("click", async () => {
  if (!isSignedIn()) {
    toast("Saved locally. Sign in to also sync to OneDrive.");
    return;
  }
  toast("Saving to OneDrive...");
  const result = await annotations.saveToOneDrive(currentBookMeta);
  toast(result.ok ? "Saved to OneDrive" : `Saved locally only (${result.reason})`);
});

annotations.onChange((state) => {
  el("undoBtn").disabled = !state.canUndo;
  el("redoBtn").disabled = !state.canRedo;
  el("statusDot").classList.toggle("dirty", state.dirty);
});

// Best-effort autosave to OneDrive when the tab is hidden/closed.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && currentBookMeta && annotations.isDirty() && isSignedIn()) {
    annotations.saveToOneDrive(currentBookMeta).catch(() => {});
  }
});

// ---- Boot ------------------------------------------------------------------

// Version chip: shows which build is running, and tapping it forces an update
// check and reload so you never have to guess whether you're on the latest.
el("versionChip").textContent = `v${APP_VERSION}`;
el("versionChip").addEventListener("click", async () => {
  toast(`Shelf v${APP_VERSION} — checking for updates…`);
  try {
    if (window.__shelfCheckUpdate) await window.__shelfCheckUpdate();
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.update()));
  } catch (_) { /* offline: nothing to check against */ }
  setTimeout(() => window.location.reload(), 600);
});

(async function boot() {
  try {
    await initAuth();
  } catch (err) {
    console.warn("Auth init skipped:", err.message);
  }
  await refreshSignInUI();
  await renderLibrary();
})();
