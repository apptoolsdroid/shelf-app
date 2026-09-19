// ============================================================================
// Bookshelf: merges books imported locally with books synced from OneDrive,
// and renders the grid. "Import locally" (a file picked from the iPad/Android
// file system) and "OneDrive" are just two ways a book's bytes end up in the
// same local cache (js/db.js) — the reader doesn't care which.
// ============================================================================
import * as db from "./db.js";
import * as cloud from "./cloud.js";
const isSignedIn = () => cloud.isSignedIn();

function guessFormat(name) {
  return name.toLowerCase().endsWith(".pdf") ? "pdf" : "epub";
}

function idForOneDriveItem(itemId) {
  return `od_${itemId}`;
}

function idForCloudItem(provider, itemId) {
  return provider === "gdrive" ? `gd_${itemId}` : `od_${itemId}`;
}

// The name a local book takes in the cloud folder. Keeping the original
// filename means the copy is recognisable if you ever open the folder itself.
function cloudFileName(meta) {
  const ext = meta.format === "pdf" ? ".pdf" : ".epub";
  return meta.title.endsWith(ext) ? meta.title : `${meta.title}${ext}`;
}

// Deterministic on purpose: importing the same file twice produces the same
// id, which is what lets importLocalFile detect a duplicate instead of adding
// a second copy of the same book to the shelf. Size is included so two
// genuinely different files that happen to share a name don't collide.
function idForLocalFile(name, size) {
  return `local_${name}_${size}`;
}

// Pull the current file listing from the OneDrive Books folder and make sure
// each one has a local cache entry (metadata only — bytes are lazy-loaded
// the first time the book is opened, to keep sync fast and cheap on data).
export async function syncFromOneDrive() {
  if (!isSignedIn()) return { ok: false, reason: "not-signed-in" };
  const providerName = cloud.getProviderName();
  const source = providerName === "gdrive" ? "gdrive" : "onedrive";
  const idField = providerName === "gdrive" ? "gdriveFileId" : "oneDriveItemId";

  await cloud.ensureBooksFolder();
  const items = await cloud.listBooks();

  // 1. Pull: everything in the cloud folder becomes a book on this device.
  const seenNames = new Set();
  for (const item of items) {
    seenNames.add(item.name);
    const id = idForCloudItem(providerName, item.id);
    const existing = await db.getBookMeta(id);
    await db.saveBookMeta({
      ...(existing || {}),
      id,
      source,
      [idField]: item.id,
      oneDriveFileName: item.name, // the sidecar name, whichever drive it's on
      title: existing?.title || stripExt(item.name),
      author: existing?.author || "",
      format: guessFormat(item.name),
      cachedLocally: existing?.cachedLocally || false,
      lastLocation: existing?.lastLocation || null,
      updatedAt: item.lastModifiedDateTime,
    });
  }

  // 2. Push: books imported on this device get uploaded, which is what makes
  // them appear on your other devices at all. Books already in the folder are
  // skipped by name so syncing twice doesn't duplicate anything.
  let uploaded = 0;
  const locals = (await db.getAllBooks()).filter((b) => b.source === "local" && !b.cloudPushedAs);
  for (const meta of locals) {
    const name = cloudFileName(meta);
    if (seenNames.has(name)) {
      await db.saveBookMeta({ ...meta, cloudPushedAs: name });
      continue;
    }
    const blob = await db.getBookFile(meta.id);
    if (!blob) continue;
    try {
      await cloud.uploadBook(name, blob);
      await db.saveBookMeta({ ...meta, cloudPushedAs: name, oneDriveFileName: name });
      uploaded++;
    } catch (err) {
      // One unuploadable book shouldn't abort the whole sync.
      console.warn("Could not upload", name, err);
    }
  }

  // 3. Shelves travel too, so categories match across devices.
  await syncShelfLayout();

  return { ok: true, count: items.length, uploaded };
}

// ---- Shelf layout sync ------------------------------------------------------
// Custom shelves live only on the device that made them unless they're written
// somewhere shared. This keeps a small manifest in the cloud folder and merges
// it with what's here, newest wins per shelf.
const LAYOUT_FILE = "shelf-library.json";

// A book's id is device-local: the same book is `local_…` on the device that
// imported it and `gd_…`/`od_…` on a device that got it from the drive. Shelf
// membership therefore can't travel as ids — it travels as this stable key,
// derived from the file's name in the drive, which both devices agree on.
function bookKey(meta) {
  const name = meta.cloudPushedAs || meta.oneDriveFileName;
  if (name) return `f:${String(name).toLowerCase()}`;
  return `t:${String(meta.title || "").toLowerCase()}:${meta.format}`;
}

export async function syncShelfLayout() {
  if (!isSignedIn()) return { ok: false, reason: "not-signed-in" };

  const books = await db.getAllBooks();
  const idToKey = new Map(books.map((b) => [b.id, bookKey(b)]));
  const keyToId = new Map();
  for (const b of books) if (!keyToId.has(bookKey(b))) keyToId.set(bookKey(b), b.id);

  const localShelves = await db.getAllShelves();
  let remote = null;
  try {
    remote = await cloud.downloadJson(LAYOUT_FILE);
  } catch (_) { /* first run, or no manifest yet */ }

  const byId = new Map();
  // Remote shelves arrive keyed by book key; translate them into whatever ids
  // those books happen to have on this device, dropping any this device
  // doesn't have yet.
  for (const s of (remote && remote.shelves) || []) {
    byId.set(s.id, {
      ...s,
      bookIds: (s.bookKeys || []).map((k) => keyToId.get(k)).filter(Boolean),
    });
  }
  for (const s of localShelves) {
    const other = byId.get(s.id);
    if (!other) { byId.set(s.id, s); continue; }
    const mine = Date.parse(s.updatedAt || s.createdAt || 0) || 0;
    const theirs = Date.parse(other.updatedAt || other.createdAt || 0) || 0;
    byId.set(s.id, theirs > mine ? other : s);
  }

  const merged = [...byId.values()].map((s) => ({
    id: s.id, name: s.name, bookIds: s.bookIds || [],
    createdAt: s.createdAt, updatedAt: s.updatedAt || s.createdAt,
  }));
  for (const s of merged) await db.saveShelfRecord(s);

  await cloud.uploadJson(LAYOUT_FILE, {
    version: 1,
    updatedAt: new Date().toISOString(),
    shelves: merged.map((s) => ({
      ...s,
      bookKeys: (s.bookIds || []).map((id) => idToKey.get(id)).filter(Boolean),
    })),
  });
  return { ok: true, shelves: merged.length };
}

function stripExt(name) {
  return name.replace(/\.(epub|pdf)$/i, "");
}

// Imports a book the user picked from their device's own file system
// (works with no OneDrive connection at all).
// Returns { meta, duplicate }. If the book is already on the shelf we keep the
// existing entry untouched rather than overwriting it — re-importing a book
// must never wipe out your reading position, bookmarks or underlines.
export async function importLocalFile(file) {
  const id = idForLocalFile(file.name, file.size);
  const existing = await db.getBookMeta(id);
  if (existing) return { meta: existing, duplicate: true };

  await db.saveBookFile(id, file);
  const meta = {
    id,
    source: "local",
    oneDriveItemId: null,
    oneDriveFileName: null,
    title: stripExt(file.name),
    author: "",
    format: guessFormat(file.name),
    cachedLocally: true,
    lastLocation: null,
    progress: 0,
    updatedAt: new Date().toISOString(),
  };
  await db.saveBookMeta(meta);
  return { meta, duplicate: false };
}

export async function getShelf({ includeHidden = false } = {}) {
  const books = await db.getAllBooks();
  const visible = includeHidden ? books : books.filter((b) => !b.hidden);
  return visible.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

// Makes sure the raw bytes for a book are available locally, downloading
// from OneDrive the first time (and caching it after that, so re-opening is
// instant and works offline).
export async function ensureBookBytes(meta) {
  let blob = await db.getBookFile(meta.id);
  if (blob) return blob;

  if (meta.source === "onedrive" || meta.source === "gdrive") {
    blob = await cloud.downloadBookContent(meta);
    await db.saveBookFile(meta.id, blob);
    await db.saveBookMeta({ ...meta, cachedLocally: true });
    return blob;
  }
  throw new Error("Book file is missing and has no cloud copy to re-download from.");
}

// `progress` is a 0–1 fraction used to draw the bar on the book's cover. PDFs
// report it exactly (page / total); EPUBs approximate it from position in the
// spine, since computing true percentages means indexing the whole book.
export async function saveLastLocation(bookId, location, progress) {
  const meta = await db.getBookMeta(bookId);
  if (!meta) return;
  meta.lastLocation = location;
  if (typeof progress === "number" && isFinite(progress)) {
    meta.progress = Math.min(1, Math.max(0, progress));
  } else if (location && typeof location === "object" && location.numPages) {
    meta.progress = Math.min(1, (location.page || 1) / location.numPages);
  }
  meta.updatedAt = new Date().toISOString();
  await db.saveBookMeta(meta);
}

// Deletes the book's metadata, cached bytes and annotations, and also unfiles
// it from every custom shelf so deleted books can't linger as phantom entries
// in a category's member list.
export async function removeBook(bookId) {
  await db.deleteBook(bookId);
  const shelves = await db.getAllShelves();
  for (const s of shelves) {
    if (s.bookIds && s.bookIds.includes(bookId)) {
      s.bookIds = s.bookIds.filter((id) => id !== bookId);
      await db.saveShelfRecord(s);
    }
  }
}

// ---- Shelves (categories) ---------------------------------------------------
// A shelf is just a named filter over the flat book list. "Smart" shelves are
// computed automatically from book metadata; custom shelves are user-created
// and remember which books were explicitly added to them.

// ---- Duplicate detection ----------------------------------------------------
// Two entries count as the same book when their titles match once punctuation,
// case and spacing are ignored, and they're the same format. This deliberately
// catches copies that arrived by different routes — one imported from Files and
// one synced from OneDrive have completely different ids, but they're still the
// same book to a reader.
function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\.(epub|pdf)$/i, "")
    // Strip the marks download folders and file managers add to second copies:
    // "book (1)", "book copy", "book - Copy 2". Without this the very files
    // most likely to BE duplicates are the ones that fail to match.
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s*-?\s*copy(\s*\d+)?\s*$/i, "")
    .replace(/[_\-–—]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function duplicateKey(book) {
  return `${normalizeTitle(book.title)}|${book.format}`;
}

// Groups of 2+ books that all look like the same title.
export function findDuplicateGroups(books) {
  const byKey = new Map();
  for (const b of books) {
    const k = duplicateKey(b);
    if (!k.startsWith("|")) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(b);
    }
  }
  return [...byKey.values()].filter((g) => g.length > 1);
}

// Which copy to keep: the one you've read furthest into, falling back to the
// most recently touched. Losing reading position to a cleanup would be worse
// than leaving a duplicate on the shelf.
function bestCopy(group) {
  return [...group].sort((a, b) => {
    const pa = a.progress || 0;
    const pb = b.progress || 0;
    if (pb !== pa) return pb - pa;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  })[0];
}

export async function setBookHidden(bookId, hidden) {
  const meta = await db.getBookMeta(bookId);
  if (!meta) return;
  meta.hidden = !!hidden;
  await db.saveBookMeta(meta);
}

// Hides every copy except the best one in each duplicate group. Hiding rather
// than deleting is deliberate — nothing is destroyed, and the Hidden shelf lets
// you put anything back.
export async function hideDuplicates() {
  const books = await getShelf({ includeHidden: false });
  const groups = findDuplicateGroups(books);
  let hiddenCount = 0;
  for (const group of groups) {
    const keep = bestCopy(group);
    for (const b of group) {
      if (b.id !== keep.id) {
        await setBookHidden(b.id, true);
        hiddenCount++;
      }
    }
  }
  return hiddenCount;
}

const SMART_SHELF_DEFS = [
  { id: "smart:all", name: "All Books", always: true, match: () => true },
  { id: "smart:continue", name: "Continue Reading", always: false, match: (b) => !!b.lastLocation },
  { id: "smart:duplicates", name: "Duplicates", always: false, match: (b, ctx) => ctx.duplicateIds.has(b.id) },
  { id: "smart:onedrive", name: "OneDrive", always: false, match: (b) => b.source === "onedrive" },
  { id: "smart:local", name: "On This Device", always: false, match: (b) => b.source === "local" },
  { id: "smart:epub", name: "EPUB", always: false, match: (b) => b.format === "epub" },
  { id: "smart:pdf", name: "PDF", always: false, match: (b) => b.format === "pdf" },
];

// Returns every shelf that should appear in the rail: [{ id, name, kind, books }]
// Smart shelves that would be empty are omitted (except "All Books", which is
// always present as a home base) so the rail doesn't fill up with dead tabs.
export async function listAllShelves() {
  const all = await getShelf({ includeHidden: true });
  const books = all.filter((b) => !b.hidden);
  const hiddenBooks = all.filter((b) => b.hidden);

  const duplicateIds = new Set();
  for (const group of findDuplicateGroups(books)) {
    for (const b of group) duplicateIds.add(b.id);
  }
  const ctx = { duplicateIds };

  const shelves = [];
  for (const def of SMART_SHELF_DEFS) {
    const matched = books.filter((b) => def.match(b, ctx));
    if (def.always || matched.length > 0) {
      shelves.push({ id: def.id, name: def.name, kind: "smart", books: matched });
    }
  }

  // Hidden books live only here, so they're out of the way but never lost.
  if (hiddenBooks.length > 0) {
    shelves.push({ id: "smart:hidden", name: "Hidden", kind: "smart", books: hiddenBooks });
  }

  const customRecords = await db.getAllShelves();
  customRecords.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  for (const rec of customRecords) {
    const matched = books.filter((b) => rec.bookIds.includes(b.id));
    shelves.push({ id: rec.id, name: rec.name, kind: "custom", books: matched });
  }

  return shelves;
}

export async function createCustomShelf(name) {
  const id = `shelf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  await db.saveShelfRecord({ id, name, bookIds: [], createdAt: now, updatedAt: now });
  return id;
}

export async function deleteCustomShelf(shelfId) {
  await db.deleteShelfRecord(shelfId);
}

export async function getCustomShelfRecords() {
  return db.getAllShelves();
}

export async function toggleBookInCustomShelf(shelfId, bookId) {
  const shelves = await db.getAllShelves();
  const rec = shelves.find((s) => s.id === shelfId);
  if (!rec) return;
  const has = rec.bookIds.includes(bookId);
  rec.bookIds = has ? rec.bookIds.filter((id) => id !== bookId) : [...rec.bookIds, bookId];
  rec.updatedAt = new Date().toISOString();
  await db.saveShelfRecord(rec);
  return !has; // true if the book is now in the shelf
}

// Groups a shelf's books into sub-categories for display — this is the "a
// shelf opens with different categories inside it" behavior. Format is the
// one dimension every shelf can be usefully split by.
export function groupByFormat(books) {
  const sections = [
    { label: "EPUB", books: books.filter((b) => b.format === "epub") },
    { label: "PDF", books: books.filter((b) => b.format === "pdf") },
  ];
  return sections.filter((s) => s.books.length > 0);
}
