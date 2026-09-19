// ============================================================================
// Annotation engine: underlines + bookmarks, with a real undo/redo stack and
// explicit Save (to local cache immediately, to OneDrive on demand).
//
// Every edit goes through `applyAction`, which records an inverse so it can
// be undone. Undo/redo stacks are per-book and reset when you switch books.
// ============================================================================
import * as db from "./db.js";
import * as oneDrive from "./oneDrive.js";
import { isSignedIn } from "./msalAuth.js";

let currentBookId = null;
let currentDoc = null; // { bookId, annotations, updatedAt, dirty }
let undoStack = [];
let redoStack = [];

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  const state = {
    annotations: currentDoc ? currentDoc.annotations : [],
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    dirty: currentDoc ? currentDoc.dirty : false,
  };
  listeners.forEach((fn) => fn(state));
}

export async function loadForBook(bookId) {
  currentBookId = bookId;
  currentDoc = await db.getAnnotationsDoc(bookId);
  undoStack = [];
  redoStack = [];
  notify();
  return currentDoc.annotations;
}

function uid() {
  return `a_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function persistLocal() {
  currentDoc.updatedAt = new Date().toISOString();
  currentDoc.dirty = true;
  await db.saveAnnotationsDoc(currentDoc);
  notify();
}

// A single mutation entry: { do: () => annotations mutation, undo: () => inverse }
async function applyAction(action) {
  action.redo();
  undoStack.push(action);
  redoStack = [];
  await persistLocal();
}

// ---- Public mutation API ---------------------------------------------------

// range: for EPUB, an epub.js CFI range string; for PDF, { page, rects: [...] }
export async function addUnderline({ range, text, color = "#f5c542", format }) {
  const record = { id: uid(), type: "underline", format, range, text, color, createdAt: Date.now() };
  await applyAction({
    redo: () => currentDoc.annotations.push(record),
    undo: () => {
      currentDoc.annotations = currentDoc.annotations.filter((a) => a.id !== record.id);
    },
  });
  return record;
}

export async function addBookmark({ position, format, label }) {
  const record = { id: uid(), type: "bookmark", format, position, label: label || "Bookmark", createdAt: Date.now() };
  await applyAction({
    redo: () => currentDoc.annotations.push(record),
    undo: () => {
      currentDoc.annotations = currentDoc.annotations.filter((a) => a.id !== record.id);
    },
  });
  return record;
}

export async function removeAnnotation(id) {
  const removed = currentDoc.annotations.find((a) => a.id === id);
  if (!removed) return;
  await applyAction({
    redo: () => {
      currentDoc.annotations = currentDoc.annotations.filter((a) => a.id !== id);
    },
    undo: () => currentDoc.annotations.push(removed),
  });
}

export async function undo() {
  const action = undoStack.pop();
  if (!action) return;
  action.undo();
  redoStack.push(action);
  await persistLocal();
}

export async function redo() {
  const action = redoStack.pop();
  if (!action) return;
  action.redo();
  undoStack.push(action);
  await persistLocal();
}

export function getCurrentAnnotations() {
  return currentDoc ? currentDoc.annotations : [];
}

export function isDirty() {
  return currentDoc ? currentDoc.dirty : false;
}

// Explicit Save: local cache is already up to date after every edit, so this
// step is specifically "push the sidecar to OneDrive now" — used by the Save
// button, and attempted automatically when the book closes / app backgrounds.
export async function saveToOneDrive(bookMeta) {
  if (!currentDoc) return { ok: true, skipped: true };
  if (!isSignedIn()) return { ok: false, reason: "not-signed-in" };
  if (!bookMeta || !bookMeta.oneDriveFileName) return { ok: false, reason: "no-onedrive-copy" };

  await oneDrive.uploadAnnotations(bookMeta.oneDriveFileName, {
    bookId: currentDoc.bookId,
    annotations: currentDoc.annotations,
    updatedAt: currentDoc.updatedAt,
  });
  currentDoc.dirty = false;
  await db.saveAnnotationsDoc(currentDoc);
  notify();
  return { ok: true };
}

// Called once when a book that has a OneDrive copy is opened, to reconcile
// the local cache with whatever's in the OneDrive sidecar (newest wins).
export async function reconcileWithOneDrive(bookMeta) {
  if (!isSignedIn() || !bookMeta.oneDriveFileName) return;
  const remote = await oneDrive.downloadAnnotations(bookMeta.oneDriveFileName);
  if (!remote) return; // nothing remote yet — local is authoritative
  const remoteTime = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;
  const localTime = currentDoc.updatedAt ? Date.parse(currentDoc.updatedAt) : 0;
  if (remoteTime > localTime) {
    currentDoc = { bookId: bookMeta.id, annotations: remote.annotations || [], updatedAt: remote.updatedAt, dirty: false };
    await db.saveAnnotationsDoc(currentDoc);
    undoStack = [];
    redoStack = [];
    notify();
  }
}
