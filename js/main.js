// ============================================================================
// App orchestrator: wires the bookshelf (a rail of category "shelves" plus
// the books inside whichever one is open), sign-in, sync, and the reader
// (EPUB or PDF) together, and drives the toolbar (undo/redo/bookmark/save).
// ============================================================================
import { APP_VERSION } from "./version.js";
import * as cloud from "./cloud.js";
import { CONFIG } from "./config.js";
const { isSignedIn, getAccount } = cloud;
import * as shelf from "./bookshelf.js";
import * as annotations from "./annotations.js";
import * as epubReader from "./readerEpub.js";
import * as pdfReader from "./readerPdf.js";
import * as notes from "./notes.js";
import * as backup from "./backup.js";
import * as db from "./db.js";

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
  if (cloud.isSignedIn()) {
    const acc = cloud.getAccount() || {};
    const who = (acc.username || "").split("@")[0];
    btn.textContent = `Sign out${who ? ` (${who})` : ""}`;
    btn.title = `Connected to ${cloud.getProviderLabel()}`;
    dot.classList.add("online");
  } else {
    btn.textContent = "Sign in";
    btn.title = "Connect OneDrive or Google Drive";
    dot.classList.remove("online");
  }
}

function toggleProviderMenu(show) {
  el("providerMenu").classList.toggle("hidden", !show);
}

el("signInBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  // The same menu either offers the two drives, or — once connected — the
  // folder choice and sign-out.
  const connected = cloud.isSignedIn();
  el("providerConnect").classList.toggle("hidden", connected);
  el("providerAccount").classList.toggle("hidden", !connected);
  el("signInBtn").title = connected ? "Account, sync folder and backup" : "Connect a drive, or use a backup file";
  if (connected) {
    const acc = cloud.getAccount() || {};
    el("accountLabel").textContent = `${cloud.getProviderLabel()} · ${acc.username || "connected"}`;
    const folder = cloud.getFolder();
    el("currentFolderName").textContent = folder ? folder.name : CONFIG.booksFolderPath;
  }
  toggleProviderMenu(el("providerMenu").classList.contains("hidden"));
});

// ---- Library backup file ---------------------------------------------------
// The route that needs no app registration at all: a single file you keep
// wherever you like, that the Sync button reads and writes.

// ---- Sync with a backup file ------------------------------------------------
// One button, three situations:
//   * a drive is connected      -> sync with the drive
//   * the browser can hold onto a file (desktop) -> read, merge and write the
//     same file back, with nothing to confirm after the first time
//   * otherwise (iPad Safari)   -> pick the file, merge it, and hand back the
//     updated one to save over the old, because Safari won't let a page write
//     to a file you chose earlier
const BACKUP_HANDLE_KEY = "backupFileHandle";

const canHoldFiles = () =>
  typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";

async function handleWithPermission(handle) {
  if (!handle) return null;
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return handle;
  if ((await handle.requestPermission(opts)) === "granted") return handle;
  return null;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const packProgress = (verb) => (done, total) => {
  if (total > 3 && done % 3 === 0) toast(`${verb} ${done}/${total} books…`);
};

async function mergeThenRebuild(file) {
  const result = await backup.importLibrary(file, packProgress("Merging"));
  await renderLibrary();
  const blob = await backup.exportLibrary(packProgress("Packing"));
  return { result, blob };
}

async function syncWithFile() {
  // Desktop: remember the file and round-trip it silently from then on.
  if (canHoldFiles()) {
    let handle = await handleWithPermission(await db.getSetting(BACKUP_HANDLE_KEY).catch(() => null));
    if (!handle) {
      try {
        [handle] = await window.showOpenFilePicker({
          types: [{ description: "Shelf backup", accept: { "application/zip": [".zip"] } }],
          multiple: false,
        });
      } catch (_) {
        return; // the picker was dismissed
      }
      handle = await handleWithPermission(handle);
      if (!handle) { toast("Permission to that file was declined"); return; }
      // Remembering the file is a convenience — if the browser won't store the
      // handle, syncing must still go ahead and simply ask again next time.
      try {
        await db.saveSetting(BACKUP_HANDLE_KEY, handle);
      } catch (_) { /* we'll pick the file again next sync */ }
    }

    toast("Syncing with your backup file…");
    const { result, blob } = await mergeThenRebuild(await handle.getFile());
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    toast(`Synced — ${result.added} new book${result.added === 1 ? "" : "s"}, file updated`);
    return;
  }

  // iPad and anything else: pick the file each time, get the updated one back.
  pendingFileSync = true;
  el("importBackupInput").click();
}

let pendingFileSync = false;

el("syncFileBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  toggleProviderMenu(false);
  try {
    await syncWithFile();
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  }
});

el("forgetBackupBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  toggleProviderMenu(false);
  await db.deleteSetting(BACKUP_HANDLE_KEY).catch(() => {});
  toast("Forgotten — the next sync will ask for the file again");
});


el("exportBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  toggleProviderMenu(false);
  toast("Building backup…");
  try {
    const blob = await backup.exportLibrary((done, total) => {
      if (total > 3 && done % 3 === 0) toast(`Packing ${done}/${total} books…`);
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shelf-library-${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download on some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const mb = (blob.size / (1024 * 1024)).toFixed(1);
    toast(`Backup ready (${mb} MB) — save it to Drive or Files`);
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
});

el("importBackupInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  const roundTrip = pendingFileSync;
  pendingFileSync = false;
  if (!file) return;
  toggleProviderMenu(false);
  toast(roundTrip ? "Syncing with your backup file…" : "Reading backup…");
  try {
    if (roundTrip) {
      const { result, blob } = await mergeThenRebuild(file);
      // Same filename, so saving it puts the updated library back where the
      // old one was.
      downloadBlob(blob, file.name);
      toast(`Merged ${result.added} new book${result.added === 1 ? "" : "s"} — save the file back over the old one`);
    } else {
      const result = await backup.importLibrary(file, packProgress("Restoring"));
      await renderLibrary();
      toast(`Added ${result.added} book${result.added === 1 ? "" : "s"}` +
            (result.shelvesAdded ? `, ${result.shelvesAdded} shelf/shelves` : ""));
    }
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});

el("signOutBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  toggleProviderMenu(false);
  cloud.signOut();
  toast("Signed out");
  await refreshSignInUI();
});

// ---- Picking the folder to sync with ---------------------------------------
// Two devices only share a library if they point at the same folder. The first
// device creates one; the second picks it from this list.

async function openFolderPicker() {
  el("folderIntro").textContent =
    `Choose which folder in your ${cloud.getProviderLabel()} this device syncs with. ` +
    "Pick the same folder on every device to share the same books and shelves.";
  el("folderList").innerHTML = '<div class="folder-empty">Loading folders…</div>';
  el("newFolderName").value = "";
  el("folderOverlay").classList.remove("hidden");

  let folders = [];
  try {
    folders = await cloud.listFolders();
  } catch (err) {
    el("folderList").innerHTML = `<div class="folder-empty">Couldn't list folders: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const currentFolder = cloud.getFolder();
  if (folders.length === 0) {
    el("folderList").innerHTML =
      '<div class="folder-empty">No folders this app can see yet — create one below.</div>';
    return;
  }

  el("folderList").innerHTML = "";
  for (const f of folders) {
    const isCurrent = currentFolder ? currentFolder.id === f.id : f.name === CONFIG.booksFolderPath;
    const row = document.createElement("button");
    row.className = "folder-row" + (isCurrent ? " current" : "");
    row.innerHTML = `<span class="folder-mark">${isCurrent ? "✓" : ""}</span>${escapeHtml(f.name)}`;
    row.addEventListener("click", async () => {
      cloud.setFolder(f);
      el("folderOverlay").classList.add("hidden");
      toast(`Syncing with "${f.name}"`);
      await syncNow();
    });
    el("folderList").appendChild(row);
  }
}

el("chooseFolderBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  toggleProviderMenu(false);
  await openFolderPicker();
});

el("folderCancel").addEventListener("click", () => el("folderOverlay").classList.add("hidden"));

el("folderCreate").addEventListener("click", async () => {
  const name = el("newFolderName").value.trim();
  if (!name) { toast("Give the folder a name first"); return; }
  try {
    const folder = await cloud.createFolder(name);
    cloud.setFolder(folder);
    el("folderOverlay").classList.add("hidden");
    toast(`Created "${folder.name}" and syncing with it`);
    await syncNow();
  } catch (err) {
    toast(`Couldn't create folder: ${err.message}`);
  }
});


// ---- One-time cloud setup --------------------------------------------------
// Both Google and Microsoft require an app to identify itself with a client ID
// before they'll let it touch your files; there's no way round registering one.
// What we can avoid is making you edit a file and redeploy the site, so the ID
// is pasted here and kept on the device.

const SETUP_COPY = {
  gdrive: {
    title: "Connect Google Drive",
    storageKey: "shelf.googleClientId",
    inputLabel: "Google OAuth client ID",
    intro: "Google needs this app registered before it will hand over access to your Drive. " +
           "It's free and takes about five minutes, and you only do it once.",
    steps: [
      'Open <a href="https://console.cloud.google.com" target="_blank" rel="noopener">console.cloud.google.com</a> and create a project.',
      'In <strong>APIs &amp; Services → Library</strong>, enable the <strong>Google Drive API</strong>.',
      'In <strong>OAuth consent screen</strong>, choose <strong>External</strong>, fill in a name and your email, and add your own Google account under <strong>Test users</strong>.',
      'In <strong>Credentials → Create credentials → OAuth client ID</strong>, pick <strong>Web application</strong> and add the address below under <strong>Authorised JavaScript origins</strong>.',
      "Copy the client ID it gives you and paste it below.",
    ],
    note: "Your Google password and two-factor code are entered on Google's own sign-in page — " +
          "this app never sees them. Once connected it creates a Books folder in your Drive and " +
          "syncs to it, while still keeping every book on this device for offline reading.",
  },
  onedrive: {
    title: "Connect Microsoft OneDrive",
    storageKey: "shelf.msClientId",
    inputLabel: "Azure application (client) ID",
    intro: "Microsoft needs this app registered before it will hand over access to your OneDrive. " +
           "It's free and takes about five minutes, and you only do it once.",
    steps: [
      'Open <a href="https://portal.azure.com" target="_blank" rel="noopener">portal.azure.com</a> → <strong>App registrations</strong> → <strong>New registration</strong>.',
      'Choose <strong>Personal Microsoft accounts only</strong> (or the option that also allows work accounts).',
      'Under <strong>Authentication → Add a platform → Single-page application</strong>, add the address below as the redirect URI.',
      'Under <strong>API permissions</strong>, add Microsoft Graph → delegated → <strong>Files.ReadWrite</strong>.',
      "Copy the Application (client) ID from the Overview page and paste it below.",
    ],
    note: "Your Microsoft password and two-factor code are entered on Microsoft's own sign-in page — " +
          "this app never sees them. Once connected it creates a Books folder in your OneDrive and " +
          "syncs to it, while still keeping every book on this device for offline reading.",
  },
};

let setupProvider = null;

function needsSetup(name) {
  const key = SETUP_COPY[name].storageKey;
  let stored = null;
  try { stored = localStorage.getItem(key); } catch (_) {}
  if (stored && stored.trim()) return false;
  // Nothing saved in the app — fall back to whatever is in config.js, which
  // still holds the placeholder until someone edits it.
  const fromFile = name === "gdrive" ? CONFIG.google.clientId : CONFIG.clientId;
  return !fromFile || fromFile.startsWith("PASTE-");
}

function openSetup(name) {
  setupProvider = name;
  const copy = SETUP_COPY[name];
  el("setupTitle").textContent = copy.title;
  el("setupIntro").textContent = copy.intro;
  el("setupSteps").innerHTML = copy.steps.map((s) => `<li>${s}</li>`).join("");
  el("setupInputLabel").textContent = copy.inputLabel;
  el("setupNote").textContent = copy.note;
  // The exact origin to register. Getting this wrong is the single most common
  // reason sign-in fails, so it's shown rather than described.
  el("setupOrigin").value = name === "gdrive"
    ? window.location.origin
    : window.location.href.replace(/index\.html$/, "").split("#")[0].split("?")[0];
  let existing = "";
  try { existing = localStorage.getItem(copy.storageKey) || ""; } catch (_) {}
  el("setupClientId").value = existing;
  el("setupOverlay").classList.remove("hidden");
  setTimeout(() => el("setupClientId").focus(), 50);
}

function closeSetup() {
  el("setupOverlay").classList.add("hidden");
  setupProvider = null;
}

el("setupCancel").addEventListener("click", closeSetup);
el("setupOrigin").addEventListener("click", (e) => e.target.select());

el("setupSave").addEventListener("click", async () => {
  const name = setupProvider;
  const value = el("setupClientId").value.trim();
  if (!value) { toast("Paste the client ID first"); return; }
  try {
    localStorage.setItem(SETUP_COPY[name].storageKey, value);
  } catch (_) {
    toast("This browser won't let the app save settings");
    return;
  }
  closeSetup();
  await connectProvider(name);
});

async function connectProvider(name) {
  if (needsSetup(name)) { openSetup(name); return; }
  try {
    await cloud.signIn(name);
    toast(`Connected to ${cloud.getProviderLabel()}`);
  } catch (err) {
    toast(err.message);
  }
  await refreshSignInUI();
}

// Only the rows that actually name a provider — "Sync folder" and "Sign out"
// share this class for styling but have their own handlers, and would
// otherwise try to connect to a provider called `undefined`.
for (const item of document.querySelectorAll(".provider-item[data-provider]")) {
  item.addEventListener("click", async (e) => {
    e.stopPropagation();
    toggleProviderMenu(false);
    await connectProvider(item.dataset.provider);
  });
}

document.addEventListener("click", () => toggleProviderMenu(false));

// ---- Bookshelf: rail of shelves + the open shelf's panel --------------------

async function syncNow() {
  // Not connected to a drive? Then "sync" means the backup file.
  if (!cloud.isSignedIn()) {
    try {
      await syncWithFile();
    } catch (err) {
      toast(`Sync failed: ${err.message}`);
    }
    return;
  }
  toast(`Syncing with ${cloud.getProviderLabel()}…`);
  try {
    const result = await shelf.syncFromOneDrive();
    const up = result.uploaded ? `, uploaded ${result.uploaded}` : "";
    toast(`Synced ${result.count} book(s) from ${cloud.getProviderLabel()}${up}`);
    await renderLibrary();
  } catch (err) {
    toast(`Sync failed: ${err.message}`);
  }
}

el("syncBtn").addEventListener("click", syncNow);

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

// Import a whole folder as its own shelf. Where the browser supports picking a
// directory (Android Chrome, desktop) the shelf is named after the folder. iOS
// Safari ignores the directory attribute and shows a normal multi-select picker
// instead, so the same button still works there — the shelf just gets a dated
// name, and you can refile books from any cover's ⋯ menu.
el("folderInput").addEventListener("change", async (e) => {
  const files = [...e.target.files].filter((f) => /\.(epub|pdf)$/i.test(f.name));
  if (files.length === 0) {
    toast("No EPUB or PDF files found in that selection");
    e.target.value = "";
    return;
  }

  const relPath = files[0].webkitRelativePath || "";
  const folderName = relPath.includes("/") ? relPath.split("/")[0] : "";
  const shelfName = folderName || `Imported ${new Date().toLocaleDateString()}`;

  toast(`Importing ${files.length} book${files.length === 1 ? "" : "s"}…`);
  const ids = [];
  let added = 0;
  let skipped = 0;
  for (const file of files) {
    const result = await shelf.importLocalFile(file);
    ids.push(result.meta.id);
    result.duplicate ? skipped++ : added++;
  }

  // Books already on the shelf still get filed into the new category — being a
  // duplicate shouldn't stop it appearing where you asked for it.
  const shelfId = await shelf.createCustomShelf(shelfName);
  for (const id of ids) await shelf.toggleBookInCustomShelf(shelfId, id);

  expandedShelfId = shelfId;
  browseMode = "shelf";
  await renderLibrary();
  toast(`"${shelfName}": ${added} added${skipped ? `, ${skipped} already had` : ""}`);
  e.target.value = "";
});

// Fetches the current shelves and (re)draws the rail + open panel. Call this
// whenever the underlying data changed (import, sync, shelf create/delete,
// a book added to/removed from a shelf).
// "racks" = the room, every category as a bookcase. "shelf" = inside one.
let browseMode = "racks";

async function renderLibrary() {
  const shelves = await shelf.listAllShelves();
  if (!expandedShelfId || !shelves.some((s) => s.id === expandedShelfId)) {
    const continueReading = shelves.find((s) => s.id === "smart:continue");
    expandedShelfId = (continueReading && continueReading.books.length > 0)
      ? continueReading.id
      : (shelves[0] ? shelves[0].id : null);
  }
  renderRacks(shelves);
  renderRail(shelves);
  renderPanel(shelves);
  el("racksView").classList.toggle("hidden", browseMode !== "racks");
  el("libraryView").classList.toggle("hidden", browseMode !== "shelf");
}

// Spine looks are derived from the title, so a given book always gets the same
// colour and height — the racks stay recognisable between visits instead of
// reshuffling every render.
const SPINE_COLORS = [
  "#7a2f2a", "#2f4a34", "#2b3a5c", "#6b4a1f", "#4a2b4e",
  "#8a5a22", "#35504f", "#5c2733", "#3d3b2a", "#264653",
];

function spineStyle(book, i) {
  let h = 0;
  const key = `${book.title || ""}${book.id || ""}`;
  for (let c = 0; c < key.length; c++) h = (h * 31 + key.charCodeAt(c)) >>> 0;
  const color = SPINE_COLORS[h % SPINE_COLORS.length];
  const height = 74 + (h % 4) * 6;       // 74–92% of the shelf height
  const width = 17 + ((h >> 3) % 5) * 4; // 17–33px, the proportions of a real spine
  return `--c:${color}; --h:${height}%; --w:${width}px;`;
}

// A spine has room for a few characters at most, so this trims the title down
// to something recognisable rather than trying to show all of it: drop a
// leading article, then cut to a length that actually fits standing up.
function spineLabel(title) {
  // Underscores become spaces first — filenames use them as word separators, and
  // leaving them in means the leading-article strip below never matches on a
  // title like "The_Long_Road".
  const t = String(title || "")
    .replace(/\.(epub|pdf)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
  return t.length > 11 ? `${t.slice(0, 10)}…` : t;
}

function renderRacks(shelves) {
  const grid = el("racksGrid");
  grid.innerHTML = "";

  const totalBooks = shelves.reduce((n, s) => n + s.books.length, 0);
  if (totalBooks === 0) {
    grid.innerHTML = `<div class="empty-state">
      No books yet. Use the import buttons in the header to add EPUBs and PDFs from this
      device, or sign in and tap the cloud to sync your OneDrive.
    </div>`;
    return;
  }

  for (const s of shelves) {
    const rack = document.createElement("div");
    rack.className = "rack" + (s.id === expandedShelfId ? " active" : "");
    rack.dataset.shelfId = s.id;

    // Two boards per case, with the category's books spread across them.
    const shown = s.books.slice(0, 12);
    const perRow = 6;
    const rows = [shown.slice(0, perRow), shown.slice(perRow)];

    const boards = rows.map((row) => {
      // Each spine is its own button: pulling a single book off the shelf
      // should open that book, not the category it happens to sit in.
      const spines = row.map((bk) =>
        `<button class="spine" style="${spineStyle(bk)}" data-book-id="${escapeHtml(bk.id)}"
           title="${escapeHtml(bk.title)}" aria-label="Open ${escapeHtml(bk.title)}"><i>${escapeHtml(spineLabel(bk.title))}</i></button>`
      ).join("");
      return `
        <div class="rack-shelf">
          <div class="rack-books">${spines}</div>
          <div class="rack-board"></div>
        </div>`;
    }).join("");

    rack.innerHTML = `
      <div class="rack-case">${boards}</div>
      <button class="rack-plate" aria-label="Open the ${escapeHtml(s.name)} shelf">
        ${escapeHtml(s.name)}
        <span class="rack-count">${s.books.length}</span>
      </button>
    `;

    // A spine opens its book, straight back to wherever you stopped reading.
    for (const spineEl of rack.querySelectorAll(".spine")) {
      const book = s.books.find((bk) => bk.id === spineEl.dataset.bookId);
      if (!book) continue;
      spineEl.addEventListener("click", (e) => {
        e.stopPropagation(); // don't also open the shelf behind it
        openBook(book, spineEl);
      });
    }

    // The case itself, and the brass plate under it, open the category.
    rack.querySelector(".rack-case").addEventListener("click", () => openRack(s.id));
    rack.querySelector(".rack-plate").addEventListener("click", () => openRack(s.id));
    grid.appendChild(rack);
  }
}

function openRack(shelfId) {
  expandedShelfId = shelfId;
  browseMode = "shelf";
  renderLibrary();
}

function backToRacks() {
  browseMode = "racks";
  renderLibrary();
}

function renderRail(shelves) {
  const rail = el("shelfRail");
  rail.innerHTML = "";

  // Way back out to the room. First in the rail so it's always in the same
  // place, whichever category you're in.
  const back = document.createElement("button");
  back.className = "shelf-tab-back";
  back.textContent = "‹ All racks";
  back.addEventListener("click", backToRacks);
  rail.appendChild(back);

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
      ${active.id === "smart:duplicates" ? `<button class="btn primary" id="tidyDupesBtn">Hide duplicates</button>` : ""}
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

  const tidyBtn = el("tidyDupesBtn");
  if (tidyBtn) {
    tidyBtn.addEventListener("click", async () => {
      const n = await shelf.hideDuplicates();
      toast(n === 0 ? "No duplicates to hide" : `Hid ${n} duplicate${n === 1 ? "" : "s"}`);
      expandedShelfId = "smart:all";
      await renderLibrary();
    });
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
    (book.hidden
      ? `<div class="shelf-menu-item" data-action="unhide"><span class="check">👁</span>Unhide book</div>`
      : `<div class="shelf-menu-item" data-action="hide"><span class="check">🚫</span>Hide book</div>`) +
    `<div class="shelf-menu-item danger" data-action="delete"><span class="check">🗑</span>Remove book</div>`;

  menu.addEventListener("click", async (e) => {
    e.stopPropagation();
    const item = e.target.closest(".shelf-menu-item");
    if (!item) return;
    if (item.dataset.action === "hide" || item.dataset.action === "unhide") {
      const hide = item.dataset.action === "hide";
      closeShelfMenu();
      await shelf.setBookHidden(book.id, hide);
      toast(hide ? `Hidden — find it on the Hidden shelf` : `"${book.title}" is back on your shelves`);
      await renderLibrary();
      return;
    }
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
  el("fontFamilySelect").classList.toggle("hidden", visible);
  updatePageArrows();
}

// Synchronous DOM swap only (no awaits) — this is what the View Transition
// animates between "old" (the shelf, with the clicked cover) and "new" (this
// shell, with the morph surface standing in for the not-yet-loaded page).
function showReaderShell(meta) {
  currentBookMeta = meta;
  currentFormat = meta.format;
  el("titleText").textContent = meta.title;

  shelfView.classList.add("hidden");
  document.body.classList.add("reading");
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
        onTapCenter: () => toggleImmersive(),
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
    if (currentFormat === "epub") el("fontFamilySelect").value = epubReader.getFontFamily();
    updatePageArrows();
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
  closeNotes();
  pdfReader.setInkTool(false);
  refreshInkButtons();
  const closedBookId = currentBookMeta ? currentBookMeta.id : null;
  if (currentFormat === "epub") epubReader.destroy();
  if (currentFormat === "pdf") pdfReader.destroy();

  const shelves = await shelf.listAllShelves();

  const runShellSwap = () => {
    if (!expandedShelfId || !shelves.some((s) => s.id === expandedShelfId)) {
      expandedShelfId = shelves[0] ? shelves[0].id : null;
    }
    renderRacks(shelves);
    renderRail(shelves);
    renderPanel(shelves);
    readerView.classList.remove("active");
    document.body.classList.remove("immersive");
    document.body.classList.remove("reading");
    shelfView.classList.remove("hidden");
    el("pageArrowPrev").hidden = true;
    el("pageArrowNext").hidden = true;
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
  if (currentFormat !== "pdf") return;
  if (pdfReader.isInking()) return; // the pen owns the page right now
  if (pdfReader.getViewMode() === "scroll") { toggleImmersive(); return; }
  const rect = el("pdfContainer").getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width * 0.25) pdfReader.prevPage();
  else if (x > rect.width * 0.75) pdfReader.nextPage();
  else toggleImmersive();
});

el("prevArrowBtn").addEventListener("click", () => pdfReader.prevPage());
el("nextArrowBtn").addEventListener("click", () => pdfReader.nextPage());

// ---- Page turning: on-screen edge arrows, and keyboard arrows ---------------

function turnPage(dir) {
  if (currentFormat === "epub") {
    dir > 0 ? epubReader.nextPage() : epubReader.prevPage();
  } else if (currentFormat === "pdf" && pdfReader.getViewMode() !== "scroll") {
    dir > 0 ? pdfReader.nextPage() : pdfReader.prevPage();
  }
}

el("pageArrowPrev").addEventListener("click", (e) => { e.stopPropagation(); turnPage(-1); });
el("pageArrowNext").addEventListener("click", (e) => { e.stopPropagation(); turnPage(1); });

// In continuous-scroll PDFs there are no discrete pages to flip, so the arrows
// would be lying about what they do.
function updatePageArrows() {
  const scrollMode = currentFormat === "pdf" && pdfReader.getViewMode() === "scroll";
  const inking = currentFormat === "pdf" && pdfReader.isInking();
  const show = !!currentFormat && !scrollMode && !inking;
  el("pageArrowPrev").hidden = !show;
  el("pageArrowNext").hidden = !show;
}

document.addEventListener("keydown", (e) => {
  if (!readerView.classList.contains("active")) return;
  if (e.key === "ArrowLeft") { turnPage(-1); e.preventDefault(); }
  if (e.key === "ArrowRight") { turnPage(1); e.preventDefault(); }
  if (e.key === "Escape" && document.body.classList.contains("immersive")) setImmersive(false);
});

// ---- Immersive reading mode ------------------------------------------------
// Only ever entered from the reader, and always escapable by tapping the middle
// of the page again — plus Escape on a keyboard. The first time it happens we
// say how to get back, so the bars vanishing can't feel like the app breaking.
let toldAboutImmersive = false;

function setImmersive(on) {
  document.body.classList.toggle("immersive", on);
  if (on && !toldAboutImmersive) {
    toldAboutImmersive = true;
    try { localStorage.setItem("shelf.immersiveHintSeen", "1"); } catch (_) {}
    toast("Tap the middle of the page to bring the bars back");
  }
}

function toggleImmersive() {
  if (!readerView.classList.contains("active")) return;
  setImmersive(!document.body.classList.contains("immersive"));
}

try { toldAboutImmersive = localStorage.getItem("shelf.immersiveHintSeen") === "1"; } catch (_) {}

el("pdfViewModeSelect").addEventListener("change", (e) => {
  pdfReader.setViewMode(e.target.value);
  updatePageArrows();
});

el("fontFamilySelect").addEventListener("change", (e) => {
  epubReader.setFontFamily(e.target.value);
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


// ---- Ink on the page, and the notes canvas ---------------------------------

const INK_BUTTONS = { pen: "penBtn", highlighter: "hiliteBtn", eraser: "eraserBtn" };

function refreshInkButtons() {
  const active = pdfReader.getInkTool();
  for (const [tool, id] of Object.entries(INK_BUTTONS)) {
    el(id).classList.toggle("tool-active", active === tool);
  }
  document.body.classList.toggle("inking", !!active);
  updatePageArrows();
}

// Tapping the active tool again puts the pen down and hands the page back to
// text selection and page turning.
function chooseInkTool(tool) {
  pdfReader.setInkTool(pdfReader.getInkTool() === tool ? false : tool);
  refreshInkButtons();
}

el("penBtn").addEventListener("click", () => chooseInkTool("pen"));
el("hiliteBtn").addEventListener("click", () => chooseInkTool("highlighter"));
el("eraserBtn").addEventListener("click", () => chooseInkTool("eraser"));
el("inkColor").addEventListener("input", (e) => pdfReader.setInkColor(e.target.value));

const NOTE_BUTTONS = { pen: "nPenBtn", highlighter: "nHiliteBtn", eraser: "nEraserBtn", note: "nNoteBtn" };

function refreshNoteButtons() {
  for (const [tool, id] of Object.entries(NOTE_BUTTONS)) {
    el(id).classList.toggle("tool-active", notes.getTool() === tool);
  }
}

function chooseNoteTool(tool) {
  notes.setTool(tool);
  refreshNoteButtons();
}

for (const [tool, id] of Object.entries(NOTE_BUTTONS)) {
  el(id).addEventListener("click", () => chooseNoteTool(tool));
}
el("nInkColor").addEventListener("input", (e) => notes.setColor(e.target.value));

function openNotes() {
  if (!currentBookMeta) return;
  notes.init({ board: el("notesBoard"), svg: el("notesInk"), notes: el("notesNotes") });
  notes.render();
  refreshNoteButtons();
  el("notesHint").textContent = notes.isEmpty()
    ? "Scribble, or tap 🗒️ then the board to drop a note"
    : currentBookMeta.title;
  el("notesView").classList.add("active");
}

function closeNotes() {
  el("notesView").classList.remove("active");
}

el("notesBtn").addEventListener("click", openNotes);
el("notesCloseBtn").addEventListener("click", closeNotes);
el("notesSaveBtn").addEventListener("click", () => el("saveBtn").click());

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
  if (el("notesView").classList.contains("active")) notes.render();
  if (currentFormat === "pdf") pdfReader.refreshInk();
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
    await cloud.initCloud();
  } catch (err) {
    console.warn("Cloud init skipped:", err.message);
  }
  await refreshSignInUI();
  await renderLibrary();
})();
