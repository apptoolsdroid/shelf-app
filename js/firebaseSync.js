// ============================================================================
// Live sync of reading state through Firebase.
//
// What travels: where you stopped in each book, reading progress, shelves and
// categories, and every annotation — underlines, bookmarks, ink and notes.
//
// What deliberately does NOT travel: the book files themselves. Those would
// need Cloud Storage, which now requires a billed plan, whereas everything
// here fits inside Firestore's free tier with room to spare. Books get onto a
// device by importing them or via the backup file; it's your *place* in them
// that's tedious to keep in step by hand, and that's what this fixes.
//
// Books are identified by the stable key from bookshelf.js rather than their
// local database id, because the same book has a different id on each device.
// ============================================================================
import * as db from "./db.js";
import { bookKey, savePlaceholder, adoptFileIntoPlaceholder } from "./bookshelf.js";
import * as files from "./fileSync.js";

const CONFIG_KEY = "shelf.firebaseConfig";
const SDK_VERSION_KEY = "shelf.firebaseSdkVersion";
const DEFAULT_SDK_VERSION = "11.0.2";

let app = null;
let auth = null;
let store = null;
let sdk = null;
let user = null;
let unsubscribers = [];
let onRemoteChange = null;

export function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function isConfigured() {
  const c = getConfig();
  return !!(c && c.apiKey && c.projectId && c.appId);
}

export function isSignedIn() {
  return !!user;
}

export function getAccount() {
  return user ? { username: user.email || user.displayName || "Firebase" } : null;
}

// The SDK is fetched from Google's servers on demand, so the app stays fully
// usable offline for anyone who never turns this on. A test can substitute its
// own implementation by setting window.__shelfFirebaseSdk.
async function loadSdk() {
  if (sdk) return sdk;
  if (window.__shelfFirebaseSdk) {
    sdk = window.__shelfFirebaseSdk;
    return sdk;
  }
  let version = DEFAULT_SDK_VERSION;
  try { version = localStorage.getItem(SDK_VERSION_KEY) || DEFAULT_SDK_VERSION; } catch (_) {}
  const base = `https://www.gstatic.com/firebasejs/${version}`;
  try {
    const [appMod, authMod, storeMod] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`),
    ]);
    sdk = { ...appMod, ...authMod, ...storeMod };
    return sdk;
  } catch (err) {
    throw new Error(`Couldn't load Firebase ${version} — check your connection, or set a different SDK version`);
  }
}

export async function init() {
  if (!isConfigured()) return null;
  const s = await loadSdk();
  if (!app) {
    app = s.initializeApp(getConfig());
    auth = s.getAuth(app);
    store = s.getFirestore(app);
  }
  // Restore an existing session without prompting. The listener is torn down
  // *after* the wait rather than inside the callback: it can fire immediately,
  // before the unsubscribe function has even been returned, and reaching for
  // it from inside the callback then throws.
  let unsub = null;
  await new Promise((resolve) => {
    unsub = s.onAuthStateChanged(auth, (u) => {
      user = u || null;
      resolve();
    });
  });
  try { if (unsub) unsub(); } catch (_) { /* already gone */ }
  return getAccount();
}

export async function signIn() {
  if (!isConfigured()) throw new Error("Add your Firebase settings first");
  const s = await loadSdk();
  if (!app) await init();
  const provider = new s.GoogleAuthProvider();
  const result = await s.signInWithPopup(auth, provider);
  user = result.user;
  return getAccount();
}

export async function signOutFirebase() {
  stopLive();
  if (auth && sdk) await sdk.signOut(auth).catch(() => {});
  user = null;
}

function docId(key) {
  // Firestore ids can't contain "/" and can't be empty.
  return encodeURIComponent(key).replace(/%2F/gi, "_") || "unknown";
}

// Best effort at recovering a key from a document id, for records written
// before the key was stored as a field of its own. Keys are lowercase
// "f:<filename>" or "t:<title>:<format>", neither of which normally contains a
// slash, so this is exact in practice — and anything it can't decode is simply
// skipped rather than guessed at.
function safeDecodeId(id) {
  try {
    const decoded = decodeURIComponent(String(id));
    return /^[ft]:/.test(decoded) ? decoded : null;
  } catch (_) {
    return null;
  }
}

const ms = (v) => (v ? Date.parse(v) || 0 : 0);

// ---- The sync itself --------------------------------------------------------
// Deliberately simple and last-write-wins per record. Two devices editing the
// same book's annotations within seconds of each other is not a real scenario
// here, and a simple rule you can reason about beats a clever one you can't.

// Only one sync may be in flight at a time. Startup, the Sync now button and
// an incoming change from another device can all fire at once, and two runs
// overlapping means both try to fill the same waiting book — one of them loses,
// and the book it was carrying quietly stays empty.
let activeRun = null;

export function syncNow(onProgress = null) {
  if (activeRun) return activeRun;
  activeRun = runSync(onProgress).finally(() => { activeRun = null; });
  return activeRun;
}

async function runSync(onProgress) {
  if (!user) return { ok: false, reason: "not-signed-in" };
  const s = await loadSdk();
  const uid = user.uid;

  const books = await db.getAllBooks();
  const byKey = new Map();
  for (const b of books) if (!byKey.has(bookKey(b))) byKey.set(bookKey(b), b);

  let pulled = 0;
  let pushed = 0;

  // --- Reading positions -----------------------------------------------------
  const remoteBooks = await s.getDocs(s.collection(store, `users/${uid}/books`));
  const remoteByKey = new Map();
  remoteBooks.forEach((d) => remoteByKey.set(d.id, d.data()));

  // Compare when the position last moved, not when the record was last
  // touched. Older records predate positionUpdatedAt, so fall back to their
  // updatedAt only if they actually hold a position.
  const positionTime = (rec) =>
    ms(rec && rec.positionUpdatedAt) || (rec && rec.lastLocation ? ms(rec.updatedAt) : 0);

  for (const [key, local] of byKey) {
    const id = docId(key);
    const remote = remoteByKey.get(id);
    const localPos = positionTime(local);
    const remotePos = positionTime(remote);

    if (remote && remote.lastLocation && remotePos > localPos) {
      await db.saveBookMeta({
        ...local,
        lastLocation: remote.lastLocation,
        progress: remote.progress ?? local.progress,
        hidden: remote.hidden ?? local.hidden,
        positionUpdatedAt: remote.positionUpdatedAt || remote.updatedAt,
      });
      pulled++;
    } else if (!remote || (local.lastLocation && localPos > remotePos)) {
      // A book with no position is still worth recording the first time it's
      // seen, but it must never overwrite a real position from another device.
      await s.setDoc(s.doc(store, `users/${uid}/books/${id}`), {
        // The key is stored alongside the data as well as being the document
        // id. The id has to be squeezed into what Firestore allows, which is
        // not reversible for every key; this field always reads back exactly.
        key,
        title: local.title || "",
        format: local.format || "",
        lastLocation: local.lastLocation ?? null,
        progress: local.progress ?? 0,
        hidden: !!local.hidden,
        positionUpdatedAt: local.positionUpdatedAt || null,
        updatedAt: local.updatedAt || new Date().toISOString(),
      });
      pushed++;
    }
  }

  // Books this device has never seen. Without this step the loop above only
  // ever visits books that already exist locally, so a second device pulled
  // the shelves down and then had nothing to put on them — every shelf arrived
  // empty, which reads as a broken sync. The file can't travel (that needs a
  // paid plan), but the book itself, its progress and its notes can, and the
  // record left here is what the file attaches to when it's imported.
  for (const [id, remote] of remoteByKey) {
    const key = remote.key || safeDecodeId(id);
    if (!key || byKey.has(key)) continue;
    const placeholder = await savePlaceholder({
      key,
      title: remote.title,
      format: remote.format,
      lastLocation: remote.lastLocation,
      progress: remote.progress,
      hidden: remote.hidden,
      positionUpdatedAt: remote.positionUpdatedAt,
      updatedAt: remote.updatedAt,
    });
    byKey.set(key, placeholder);
    pulled++;
  }

  // --- Annotations -----------------------------------------------------------
  const remoteAnns = await s.getDocs(s.collection(store, `users/${uid}/annotations`));
  const annByKey = new Map();
  remoteAnns.forEach((d) => annByKey.set(d.id, d.data()));

  for (const [key, local] of byKey) {
    const id = docId(key);
    const localDoc = await db.getAnnotationsDoc(local.id);
    const remote = annByKey.get(id);
    const localTime = ms(localDoc && localDoc.updatedAt);
    const remoteTime = ms(remote && remote.updatedAt);

    if (remote && remoteTime > localTime) {
      await db.saveAnnotationsDoc({
        bookId: local.id,
        annotations: remote.items || [],
        updatedAt: remote.updatedAt,
        dirty: false,
      });
      pulled++;
    } else if (localDoc && localDoc.annotations && localDoc.annotations.length && localTime > remoteTime) {
      await s.setDoc(s.doc(store, `users/${uid}/annotations/${id}`), {
        items: localDoc.annotations,
        updatedAt: localDoc.updatedAt,
      });
      pushed++;
    }
  }

  // --- Shelves ---------------------------------------------------------------
  // Built from the post-pull view of the library, placeholders included —
  // otherwise a shelf that arrives referring to books this device only just
  // learned about would map every one of them to nothing and come out empty.
  const allBooks = await db.getAllBooks();
  const idToKey = new Map(allBooks.map((b) => [b.id, bookKey(b)]));
  const keyToId = new Map();
  for (const b of allBooks) if (!keyToId.has(bookKey(b))) keyToId.set(bookKey(b), b.id);

  const localShelves = await db.getAllShelves();
  const localById = new Map(localShelves.map((sh) => [sh.id, sh]));
  const remoteShelves = await s.getDocs(s.collection(store, `users/${uid}/shelves`));
  const remoteById = new Map();
  remoteShelves.forEach((d) => remoteById.set(d.id, d.data()));

  for (const [id, remote] of remoteById) {
    const local = localById.get(id);
    if (!local || ms(remote.updatedAt) > ms(local.updatedAt || local.createdAt)) {
      await db.saveShelfRecord({
        id,
        name: remote.name,
        bookIds: (remote.bookKeys || []).map((k) => keyToId.get(k)).filter(Boolean),
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
      });
      pulled++;
    }
  }
  for (const sh of localShelves) {
    const remote = remoteById.get(sh.id);
    if (!remote || ms(sh.updatedAt || sh.createdAt) > ms(remote.updatedAt)) {
      await s.setDoc(s.doc(store, `users/${uid}/shelves/${sh.id}`), {
        name: sh.name,
        bookKeys: (sh.bookIds || []).map((bid) => idToKey.get(bid)).filter(Boolean),
        createdAt: sh.createdAt || new Date().toISOString(),
        updatedAt: sh.updatedAt || sh.createdAt || new Date().toISOString(),
      });
      pushed++;
    }
  }

  const fileResult = await syncFiles(s, uid, onProgress);

  lastResult = { ok: true, pulled, pushed, ...fileResult };
  lastRunAt = new Date().toISOString();
  return lastResult;
}

// ---- The book files themselves ----------------------------------------------
// Runs after everything above, so shelves and positions appear immediately and
// the (much slower) file transfer fills the covers in behind them.

async function syncFiles(s, uid, onProgress) {
  let index;
  try {
    index = await files.listRemoteFiles(s, store, uid);
  } catch (err) {
    // Almost always the security rules refusing the files collection. Saying
    // so beats leaving a shelf of dashed covers with no explanation.
    return { filesPulled: 0, filesPushed: 0, tooLarge: [], fileError: err.message };
  }

  let filesPulled = 0;
  let filesPushed = 0;
  const tooLarge = [];
  let fileError = null;

  const books = await db.getAllBooks();

  // Every book's outcome is written back onto its record, so the tracker can
  // say what happened to each one instead of the app quietly giving up on a
  // few and leaving you to notice. An earlier version skipped a book whose
  // chunks were incomplete with a bare `continue` — no note, no retry, no
  // trace. That is exactly the shape of "some of them aren't downloading".
  const mark = async (meta, state, extra = {}) => {
    const next = { ...meta, fileState: state, fileCheckedAt: new Date().toISOString(), ...extra };
    if (state !== "failed") delete next.fileError;
    await db.saveBookMeta(next);
  };

  // Down first: a book waiting on this device is what the reader is actually
  // looking at, so it matters more than backing up one they already have.
  const waiting = books.filter((b) => b.placeholder && index.has(docId(bookKey(b))));

  // Waiting books with nothing stored for them yet aren't broken — the device
  // that has them simply hasn't been opened since.
  for (const meta of books) {
    if (!meta.placeholder) continue;
    if (!index.has(docId(bookKey(meta)))) {
      await mark(meta, "waiting", { awaitingUpload: true });
    }
  }

  let n = 0;
  for (const meta of waiting) {
    const id = docId(bookKey(meta));
    const info = index.get(id);
    n++;
    if (onProgress) onProgress({ phase: "download", index: n, total: waiting.length, title: meta.title });
    try {
      const blob = await files.pullFile(s, store, uid, id, info);
      if (!blob) {
        await mark(meta, "failed", {
          awaitingUpload: false,
          remoteSize: info.size,
          fileError: "Only part of this book was uploaded — it will be sent again from the other device",
        });
        fileError = fileError || "a book was only partly uploaded";
        continue;
      }
      await adoptFileIntoPlaceholder(
        meta.id,
        new File([blob], info.name || `${meta.title}.${info.format || meta.format}`)
      );
      const filled = await db.getBookMeta(meta.id);
      await mark(filled || meta, "local", { awaitingUpload: false, remoteSize: info.size });
      filesPulled++;
    } catch (err) {
      await mark(meta, "failed", { awaitingUpload: false, remoteSize: info.size, fileError: err.message });
      fileError = fileError || err.message;
    }
  }

  // Up second, smallest first, so a library with one enormous PDF in it still
  // gets most of its books across quickly.
  let budget = files.LIBRARY_BUDGET_BYTES - files.totalStoredBytes(index);
  const mine = books.filter((b) => !b.placeholder);
  const sized = [];
  for (const meta of mine) {
    const blob = await db.getBookFile(meta.id);
    if (!blob) {
      // A book of ours whose bytes have gone missing — worth showing rather
      // than pretending it's fine, since it won't open either.
      await mark(meta, "missing", { fileError: "The file for this book isn't on this device" });
      continue;
    }
    if (index.has(docId(bookKey(meta)))) {
      await mark(meta, "local", { bookBytes: blob.size, storedRemotely: true });
      continue;
    }
    sized.push({ meta, blob });
  }
  sized.sort((a, b) => a.blob.size - b.blob.size);

  n = 0;
  for (const { meta, blob } of sized) {
    n++;
    if (blob.size > files.MAX_BOOK_BYTES) {
      tooLarge.push(meta.title);
      await mark(meta, "toolarge", { bookBytes: blob.size, storedRemotely: false });
      continue;
    }
    if (blob.size > budget) {
      tooLarge.push(meta.title);
      await mark(meta, "nospace", { bookBytes: blob.size, storedRemotely: false });
      continue;
    }
    if (onProgress) onProgress({ phase: "upload", index: n, total: sized.length, title: meta.title });
    try {
      await files.pushFile(s, store, uid, docId(bookKey(meta)), blob, {
        name: meta.oneDriveFileName || `${meta.title}.${meta.format}`,
        format: meta.format,
      });
      budget -= blob.size;
      filesPushed++;
      await mark(meta, "local", { bookBytes: blob.size, storedRemotely: true });
    } catch (err) {
      await mark(meta, "local", { bookBytes: blob.size, storedRemotely: false, uploadError: err.message });
      fileError = fileError || err.message;
    }
  }

  return {
    filesPulled, filesPushed, tooLarge, fileError,
    booksHere: books.filter((b) => !b.placeholder).length,
    filesStored: index.size,
    bytesStored: files.totalStoredBytes(index),
  };
}

// ---- What the app can tell you about its own syncing ------------------------
// Two devices and an invisible server between them is exactly the situation
// where "it doesn't work" is impossible to act on. This is the readout.

let lastResult = null;
let lastRunAt = null;

// One row per book, describing where its file actually is. This is what the
// tracker draws, and it's deliberately computed from the stored record rather
// than from a live query, so it reads instantly and still says something
// useful when the app is offline.
export async function getLibraryState() {
  const books = await db.getAllBooks();
  return books.map((b) => {
    let state = b.fileState;
    if (!state) state = b.placeholder ? (b.awaitingUpload ? "waiting" : "pending") : "local";
    return {
      id: b.id,
      title: b.title,
      format: b.format,
      state,
      error: b.fileError || b.uploadError || null,
      bytes: b.bookBytes || b.remoteSize || 0,
      storedRemotely: !!b.storedRemotely,
      checkedAt: b.fileCheckedAt || null,
      progress: b.progress || 0,
    };
  }).sort((a, b) => {
    const rank = { failed: 0, missing: 1, toolarge: 2, nospace: 3, waiting: 4, pending: 5, local: 6 };
    const d = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
    return d !== 0 ? d : String(a.title).localeCompare(String(b.title));
  });
}

// Re-attempt one book, or every book that isn't already here. Clearing the
// stored failure first means a book that has since been uploaded properly is
// tried again rather than being written off for good.
export async function retryBooks(bookIds = null) {
  if (!user) return { ok: false, reason: "not-signed-in" };
  const books = await db.getAllBooks();
  const targets = books.filter((b) => bookIds
    ? bookIds.includes(b.id)
    // Everything that isn't already here, not just the outright failures — a
    // book still marked "waiting" may well have been uploaded since.
    : b.fileState !== "local" && b.fileState !== "toolarge");
  for (const b of targets) {
    const next = { ...b };
    delete next.fileState;
    delete next.fileError;
    delete next.uploadError;
    // A book whose bytes are gone goes back to being a waiting entry, so the
    // download path picks it up again on the next run.
    if (!(await db.getBookFile(b.id))) {
      next.placeholder = true;
      next.syncKey = next.syncKey || bookKey(b);
    }
    await db.saveBookMeta(next);
  }
  return syncNow();
}

export function getStatus() {
  return {
    configured: isConfigured(),
    signedIn: !!user,
    account: user ? (user.email || user.displayName || "signed in") : null,
    lastRunAt,
    last: lastResult,
  };
}

// ---- Live updates -----------------------------------------------------------
// This is what makes it feel automatic: a change on another device arrives
// here without anyone tapping anything.

let syncTimer = null;
let syncInFlight = false;
let syncQueued = false;

// Four collections are watched, and one change on another device typically
// touches several of them at once. Without this they'd each kick off a full
// sync, doing the same work three or four times over and burning through the
// free tier's daily read allowance for no benefit. Nudges are coalesced into
// one run, and a nudge arriving mid-run queues exactly one more.
function nudgeSync() {
  if (syncInFlight) { syncQueued = true; return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncInFlight = true;
    try {
      const r = await syncNow(liveProgress);
      if (r.ok && (r.pulled || r.filesPulled) && onRemoteChange) onRemoteChange(r);
    } catch (_) { /* transient; the next change will try again */ }
    syncInFlight = false;
    if (syncQueued) { syncQueued = false; nudgeSync(); }
  }, 1200);
}

let liveProgress = null;

export function startLive(onChange, onProgress = null) {
  if (!user || !sdk || unsubscribers.length) return;
  onRemoteChange = onChange;
  liveProgress = onProgress;
  const uid = user.uid;
  for (const path of ["books", "annotations", "shelves", "files"]) {
    const stop = sdk.onSnapshot(
      sdk.collection(store, `users/${uid}/${path}`),
      (snap) => {
        // Ignore the echo of our own writes; only react to another device.
        const fromElsewhere = snap.docChanges().some((c) => !c.doc.metadata.hasPendingWrites);
        if (!fromElsewhere) return;
        nudgeSync();
      },
      () => {} // a dropped listener shouldn't throw into the app
    );
    unsubscribers.push(stop);
  }
}

// Called when a book is closed, so the place you reached travels now rather
// than waiting for the next time the app starts.
export function pushSoon() {
  if (user) nudgeSync();
}

export function stopLive() {
  clearTimeout(syncTimer);
  syncQueued = false;
  for (const stop of unsubscribers) {
    try { stop(); } catch (_) {}
  }
  unsubscribers = [];
}
