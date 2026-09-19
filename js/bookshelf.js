// ============================================================================
// Bookshelf: merges books imported locally with books synced from OneDrive,
// and renders the grid. "Import locally" (a file picked from the iPad/Android
// file system) and "OneDrive" are just two ways a book's bytes end up in the
// same local cache (js/db.js) — the reader doesn't care which.
// ============================================================================
import * as db from "./db.js";
import * as oneDrive from "./oneDrive.js";
import { isSignedIn } from "./msalAuth.js";

function guessFormat(name) {
  return name.toLowerCase().endsWith(".pdf") ? "pdf" : "epub";
}

function idForOneDriveItem(itemId) {
  return `od_${itemId}`;
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
  await oneDrive.ensureBooksFolder();
  const items = await oneDrive.listBooks();
  for (const item of items) {
    const id = idForOneDriveItem(item.id);
    const existing = await db.getBookMeta(id);
    await db.saveBookMeta({
      id,
      source: "onedrive",
      oneDriveItemId: item.id,
      oneDriveFileName: item.name,
      title: existing?.title || stripExt(item.name),
      author: existing?.author || "",
      format: guessFormat(item.name),
      cachedLocally: existing?.cachedLocally || false,
      lastLocation: existing?.lastLocation || null,
      updatedAt: item.lastModifiedDateTime,
    });
  }
  return { ok: true, count: items.length };
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

export async function getShelf() {
  const books = await db.getAllBooks();
  return books.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

// Makes sure the raw bytes for a book are available locally, downloading
// from OneDrive the first time (and caching it after that, so re-opening is
// instant and works offline).
export async function ensureBookBytes(meta) {
  let blob = await db.getBookFile(meta.id);
  if (blob) return blob;

  if (meta.source === "onedrive") {
    blob = await oneDrive.downloadBookContent(meta.oneDriveItemId);
    await db.saveBookFile(meta.id, blob);
    await db.saveBookMeta({ ...meta, cachedLocally: true });
    return blob;
  }
  throw new Error("Book file is missing and has no OneDrive source to re-download from.");
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

const SMART_SHELF_DEFS = [
  { id: "smart:all", name: "All Books", always: true, match: () => true },
  { id: "smart:continue", name: "Continue Reading", always: false, match: (b) => !!b.lastLocation },
  { id: "smart:onedrive", name: "OneDrive", always: false, match: (b) => b.source === "onedrive" },
  { id: "smart:local", name: "On This Device", always: false, match: (b) => b.source === "local" },
  { id: "smart:epub", name: "EPUB", always: false, match: (b) => b.format === "epub" },
  { id: "smart:pdf", name: "PDF", always: false, match: (b) => b.format === "pdf" },
];

// Returns every shelf that should appear in the rail: [{ id, name, kind, books }]
// Smart shelves that would be empty are omitted (except "All Books", which is
// always present as a home base) so the rail doesn't fill up with dead tabs.
export async function listAllShelves() {
  const books = await getShelf();
  const shelves = [];

  for (const def of SMART_SHELF_DEFS) {
    const matched = books.filter(def.match);
    if (def.always || matched.length > 0) {
      shelves.push({ id: def.id, name: def.name, kind: "smart", books: matched });
    }
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
  await db.saveShelfRecord({ id, name, bookIds: [], createdAt: new Date().toISOString() });
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
