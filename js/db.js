// ============================================================================
// Local offline cache (IndexedDB). Every book and every annotation set lives
// here first — this is what makes the app work offline and what "local
// import" means. OneDrive is a sync target on top of this, not the only copy.
// ============================================================================
const DB_NAME = "shelf-db";
const DB_VERSION = 3;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("annotations")) {
        db.createObjectStore("annotations", { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "bookId" }); // raw book bytes (Blob)
      }
      if (!db.objectStoreNames.contains("shelves")) {
        db.createObjectStore("shelves", { keyPath: "id" }); // user-created custom shelves
      }
      if (!db.objectStoreNames.contains("kv")) {
        // Small odds and ends that aren't books: currently the handle to the
        // backup file being synced with, which localStorage can't hold because
        // a file handle isn't a string.
        db.createObjectStore("kv", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Books (metadata) -----------------------------------------------------

export async function saveBookMeta(book) {
  await tx("books", "readwrite", (store) => store.put(book));
}

export async function getAllBooks() {
  const db = await openDb();
  return reqToPromise(db.transaction("books", "readonly").objectStore("books").getAll());
}

export async function getBookMeta(bookId) {
  const db = await openDb();
  return reqToPromise(db.transaction("books", "readonly").objectStore("books").get(bookId));
}

export async function deleteBook(bookId) {
  await tx("books", "readwrite", (store) => store.delete(bookId));
  await tx("files", "readwrite", (store) => store.delete(bookId));
  await tx("annotations", "readwrite", (store) => store.delete(bookId));
}

// ---- Raw file bytes ---------------------------------------------------------

export async function saveBookFile(bookId, blob) {
  await tx("files", "readwrite", (store) => store.put({ bookId, blob }));
}

export async function getBookFile(bookId) {
  const db = await openDb();
  const row = await reqToPromise(db.transaction("files", "readonly").objectStore("files").get(bookId));
  return row ? row.blob : null;
}

// ---- Annotations ------------------------------------------------------------
// Shape: { bookId, annotations: [...], updatedAt, dirty }

export async function getAnnotationsDoc(bookId) {
  const db = await openDb();
  const doc = await reqToPromise(
    db.transaction("annotations", "readonly").objectStore("annotations").get(bookId)
  );
  return doc || { bookId, annotations: [], updatedAt: null, dirty: false };
}

export async function saveAnnotationsDoc(doc) {
  await tx("annotations", "readwrite", (store) => store.put(doc));
}

export async function getAllDirtyAnnotationDocs() {
  const all = await new Promise(async (resolve, reject) => {
    const db = await openDb();
    const req = db.transaction("annotations", "readonly").objectStore("annotations").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return all.filter((d) => d.dirty);
}

// ---- Custom shelves ---------------------------------------------------------
// Shape: { id, name, bookIds: [...], createdAt }

export async function getAllShelves() {
  const db = await openDb();
  return reqToPromise(db.transaction("shelves", "readonly").objectStore("shelves").getAll());
}

export async function saveShelfRecord(shelf) {
  await tx("shelves", "readwrite", (store) => store.put(shelf));
}

export async function deleteShelfRecord(id) {
  await tx("shelves", "readwrite", (store) => store.delete(id));
}


// ---- Small key/value settings ----------------------------------------------

export async function getSetting(key) {
  const rec = await tx("kv", "readonly", (store) => reqToPromise(store.get(key)));
  const value = await rec;
  return value ? value.value : null;
}

export async function saveSetting(key, value) {
  await tx("kv", "readwrite", (store) => store.put({ key, value }));
}

export async function deleteSetting(key) {
  await tx("kv", "readwrite", (store) => store.delete(key));
}
