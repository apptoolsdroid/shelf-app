// ============================================================================
// Library backup: the whole library — books, shelves, reading positions,
// underlines, ink and notes — as a single .zip file.
//
// This is the no-registration route to a second device. Export here, put the
// file wherever you like (Google Drive and OneDrive both appear as locations
// in the tablet's Files app), then import it on the other device. Nothing
// talks to an API, nothing needs a client ID; the file is just a file.
//
// The trade-off versus a real cloud connection is that it's a snapshot you
// move by hand rather than continuous two-way sync.
// ============================================================================
import * as db from "./db.js";

const MANIFEST = "shelf-library.json";

function extFor(meta) {
  return meta.format === "pdf" ? "pdf" : "epub";
}

// Builds the archive. Book bytes dominate the size, so this reports progress —
// a few hundred megabytes of PDFs takes a moment to compress.
export async function exportLibrary(onProgress) {
  if (typeof JSZip === "undefined") throw new Error("Zip support didn't load");
  const zip = new JSZip();

  const books = await db.getAllBooks();
  const shelves = await db.getAllShelves();

  const manifest = {
    format: "shelf-library",
    version: 1,
    exportedAt: new Date().toISOString(),
    books: [],
    shelves,
    annotations: {},
  };

  const files = zip.folder("books");
  let done = 0;
  for (const meta of books) {
    const doc = await db.getAnnotationsDoc(meta.id);
    if (doc && doc.annotations && doc.annotations.length) {
      manifest.annotations[meta.id] = doc;
    }

    const blob = await db.getBookFile(meta.id);
    const entry = { ...meta, fileName: null };
    if (blob) {
      const fileName = `${meta.id}.${extFor(meta)}`;
      files.file(fileName, blob);
      entry.fileName = fileName;
    }
    manifest.books.push(entry);

    done++;
    if (onProgress) onProgress(done, books.length);
  }

  zip.file(MANIFEST, JSON.stringify(manifest, null, 2));
  return await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } });
}

// Merges an archive into this device. Existing books are left alone rather
// than overwritten, so importing a slightly older backup can't wipe out
// reading you've done since — except where the backup is genuinely newer.
export async function importLibrary(file, onProgress) {
  if (typeof JSZip === "undefined") throw new Error("Zip support didn't load");
  const zip = await JSZip.loadAsync(file);

  const manifestFile = zip.file(MANIFEST);
  if (!manifestFile) throw new Error("That doesn't look like a Shelf backup");
  const manifest = JSON.parse(await manifestFile.async("string"));
  if (manifest.format !== "shelf-library") throw new Error("That doesn't look like a Shelf backup");

  let added = 0;
  let merged = 0;
  const total = (manifest.books || []).length;

  for (let i = 0; i < total; i++) {
    const entry = manifest.books[i];
    const existing = await db.getBookMeta(entry.id);

    if (!existing) {
      const { fileName, ...meta } = entry;
      await db.saveBookMeta(meta);
      if (fileName) {
        const f = zip.file(`books/${fileName}`);
        if (f) await db.saveBookFile(entry.id, await f.async("blob"));
      }
      added++;
    } else {
      // Keep whichever copy was touched most recently.
      const mine = Date.parse(existing.updatedAt || 0) || 0;
      const theirs = Date.parse(entry.updatedAt || 0) || 0;
      if (theirs > mine) {
        const { fileName, ...meta } = entry;
        await db.saveBookMeta({ ...existing, ...meta });
      }
      if (!(await db.getBookFile(entry.id)) && entry.fileName) {
        const f = zip.file(`books/${entry.fileName}`);
        if (f) await db.saveBookFile(entry.id, await f.async("blob"));
      }
      merged++;
    }

    const incoming = (manifest.annotations || {})[entry.id];
    if (incoming) {
      const local = await db.getAnnotationsDoc(entry.id);
      const mine = Date.parse((local && local.updatedAt) || 0) || 0;
      const theirs = Date.parse(incoming.updatedAt || 0) || 0;
      if (!local || theirs > mine) {
        await db.saveAnnotationsDoc({ ...incoming, bookId: entry.id, dirty: true });
      }
    }

    if (onProgress) onProgress(i + 1, total);
  }

  // Shelves merge the same way, newest record wins.
  const localShelves = await db.getAllShelves();
  const byId = new Map(localShelves.map((s) => [s.id, s]));
  let shelvesAdded = 0;
  for (const s of manifest.shelves || []) {
    const mineRec = byId.get(s.id);
    if (!mineRec) { await db.saveShelfRecord(s); shelvesAdded++; continue; }
    const mine = Date.parse(mineRec.updatedAt || mineRec.createdAt || 0) || 0;
    const theirs = Date.parse(s.updatedAt || s.createdAt || 0) || 0;
    if (theirs > mine) await db.saveShelfRecord(s);
  }

  return { added, merged, shelvesAdded };
}
