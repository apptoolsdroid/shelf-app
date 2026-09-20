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
export function bookKey(meta) {
  // A placeholder created by sync carries the key it arrived under, so that
  // when the real file is later imported on this device the two line up
  // exactly and merge instead of appearing twice.
  if (meta.syncKey) return meta.syncKey;
  const name = meta.cloudPushedAs || meta.oneDriveFileName;
  if (name) return `f:${String(name).toLowerCase()}`;
  return `t:${String(meta.title || "").toLowerCase()}:${meta.format}`;
}

// A book known to exist — its title, your place in it, its shelf, its
// annotations — but whose file isn't on this device. Sync carries reading
// state, not book files (those need a paid Firebase plan), so without these a
// second device showed the shelves correctly and then nothing on them, which
// looks like the sync is broken rather than like a file waiting to be added.
export function isPlaceholder(meta) {
  return !!(meta && meta.placeholder);
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
  if (existing && !existing.placeholder) return { meta: existing, duplicate: true };

  // Does this file complete a book that sync already told us about? If so it
  // takes over that record rather than becoming a second copy — which keeps
  // the reading position, annotations and shelf membership that arrived from
  // the other device, since all of those hang off the placeholder's id.
  const waiting = await findPlaceholderFor(file);
  if (waiting) {
    await db.saveBookFile(waiting.id, file);
    const filled = {
      ...waiting,
      placeholder: false,
      source: "local",
      cachedLocally: true,
      title: waiting.title || stripExt(file.name),
      format: waiting.format || guessFormat(file.name),
      updatedAt: new Date().toISOString(),
    };
    delete filled.placeholder;
    await db.saveBookMeta(filled);
    return { meta: filled, duplicate: false, filledPlaceholder: true };
  }

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

// Matches a file being imported against the books sync knows about but has no
// file for. The filename is tried first because that's how books pushed to a
// drive are keyed; title-and-format catches books that were only ever local,
// where the filename on the two devices may well differ.
async function findPlaceholderFor(file) {
  const books = await db.getAllBooks();
  const pending = books.filter((b) => b.placeholder);
  if (!pending.length) return null;
  const byName = `f:${String(file.name).toLowerCase()}`;
  const byTitle = `t:${stripExt(file.name).toLowerCase()}:${guessFormat(file.name)}`;
  return pending.find((b) => bookKey(b) === byName)
      || pending.find((b) => bookKey(b) === byTitle)
      || null;
}

// Records a book that another device has, so it appears on the shelf here with
// its progress intact and can be completed by importing the file.
export async function savePlaceholder({ key, title, format, lastLocation, progress, hidden, positionUpdatedAt, updatedAt }) {
  const id = `sync_${key.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}`;
  const existing = await db.getBookMeta(id);
  if (existing && !existing.placeholder) return existing; // the file turned up in the meantime
  const meta = {
    id,
    syncKey: key,
    placeholder: true,
    source: "sync",
    title: title || "Untitled",
    author: "",
    format: format || "epub",
    cachedLocally: false,
    lastLocation: lastLocation ?? null,
    progress: progress ?? 0,
    hidden: !!hidden,
    positionUpdatedAt: positionUpdatedAt || null,
    updatedAt: updatedAt || new Date().toISOString(),
  };
  await db.saveBookMeta(meta);
  return meta;
}

// Attaches a file the reader picked to a specific waiting book, regardless of
// what it's called. Matching by name is a good guess but only a guess — the
// same book is often saved under a different filename on each device — so when
// someone taps a waiting book and chooses a file, that choice is taken as
// definitive.
export async function adoptFileIntoPlaceholder(placeholderId, file) {
  const waiting = await db.getBookMeta(placeholderId);
  if (!waiting) throw new Error("That book is no longer on your shelf");
  await db.saveBookFile(waiting.id, file);
  const filled = {
    ...waiting,
    source: "local",
    cachedLocally: true,
    format: guessFormat(file.name) || waiting.format,
    updatedAt: new Date().toISOString(),
  };
  delete filled.placeholder;
  await db.saveBookMeta(filled);
  return filled;
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
  if (meta.placeholder) {
    throw new Error(
      "This book is on your other device. Sync carries your place and your notes, " +
      "but not the file itself — import it here once and everything lines up."
    );
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
  // Tracked separately from updatedAt, which changes for any reason at all —
  // importing a book bumps it. Sync needs to know when the *position* last
  // moved, or a freshly imported blank copy looks newer than real reading.
  meta.positionUpdatedAt = new Date().toISOString();
  if (location && typeof location === "object" && location.numPages) {
    meta.numPages = location.numPages;
  }
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

// Renaming bumps updatedAt so the new name wins when shelves sync.
export async function renameCustomShelf(shelfId, name) {
  const shelves = await db.getAllShelves();
  const rec = shelves.find((sh) => sh.id === shelfId);
  if (!rec) return false;
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed === rec.name) return false;
  rec.name = trimmed;
  rec.updatedAt = new Date().toISOString();
  await db.saveShelfRecord(rec);
  return true;
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

// Puts a batch of books on a shelf in one go, and optionally takes them off
// the shelf they came from. One record write per shelf rather than one per
// book, so filing twenty books is a single change that syncs as a single
// change, rather than twenty that each race the others.
export async function moveBooksToShelf(bookIds, targetShelfId, { removeFromShelfId = null } = {}) {
  const ids = [...new Set(bookIds)].filter(Boolean);
  if (!ids.length) return { added: 0, removed: 0 };
  const shelves = await db.getAllShelves();
  const now = new Date().toISOString();
  let added = 0;
  let removed = 0;

  const target = shelves.find((s) => s.id === targetShelfId);
  if (target) {
    const before = target.bookIds.length;
    target.bookIds = [...new Set([...target.bookIds, ...ids])];
    added = target.bookIds.length - before;
    target.updatedAt = now;
    await db.saveShelfRecord(target);
  }

  // Only real shelves can have books taken off them; the smart shelves are
  // computed from the books themselves, so there's nothing to remove from.
  const source = removeFromShelfId && removeFromShelfId !== targetShelfId
    ? shelves.find((s) => s.id === removeFromShelfId)
    : null;
  if (source) {
    const before = source.bookIds.length;
    source.bookIds = source.bookIds.filter((id) => !ids.includes(id));
    removed = before - source.bookIds.length;
    source.updatedAt = now;
    await db.saveShelfRecord(source);
  }

  return { added, removed };
}

// How a shelf's books are ordered. Recent is the default because the book you
// were last in is nearly always the one you want next; the rest are here for
// finding something in a library too big to scan.
export const SORT_MODES = [
  { id: "recent", label: "Recently used" },
  { id: "title", label: "Title A–Z" },
  { id: "title-desc", label: "Title Z–A" },
  { id: "progress", label: "Furthest read" },
  { id: "unread", label: "Not started first" },
  { id: "pages", label: "Longest first" },
];

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// Sorted on a cleaned-up title, so "The_Long_Road.pdf" files under L with the
// rest of the library rather than under T with every other "The".
export function sortKeyForTitle(title) {
  return String(title || "")
    .replace(/\.(epub|pdf)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
}

export function sortBooks(books, mode) {
  const list = [...books];
  switch (mode) {
    case "title":
      return list.sort((a, b) => collator.compare(sortKeyForTitle(a.title), sortKeyForTitle(b.title)));
    case "title-desc":
      return list.sort((a, b) => collator.compare(sortKeyForTitle(b.title), sortKeyForTitle(a.title)));
    case "progress":
      return list.sort((a, b) => (b.progress || 0) - (a.progress || 0));
    case "unread":
      return list.sort((a, b) => (a.progress || 0) - (b.progress || 0));
    case "pages":
      return list.sort((a, b) => (b.numPages || 0) - (a.numPages || 0));
    default:
      return list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }
}

// Matches a typed fragment against a book. Deliberately forgiving: underscores
// and extensions are ignored, so typing "long" finds "The_Long_Road.pdf", and
// each word can match separately so "road long" finds it too.
export function bookMatches(book, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    book.title,
    book.author,
    book.format,
    book.oneDriveFileName,
  ].filter(Boolean).join(" ").replace(/[_.]+/g, " ").toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
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


// Fills in the page count for PDFs that don't have one yet. Runs after an
// import so covers show it straight away, and skips anything already counted.
export async function backfillPageCounts(getCount, onProgress) {
  const books = await db.getAllBooks();
  const todo = books.filter((b) => b.format === "pdf" && !b.numPages);
  let done = 0;
  for (const meta of todo) {
    const blob = await db.getBookFile(meta.id);
    if (blob) {
      const n = await getCount(blob);
      if (n) await db.saveBookMeta({ ...meta, numPages: n });
    }
    done++;
    if (onProgress) onProgress(done, todo.length);
  }
  return todo.length;
}
