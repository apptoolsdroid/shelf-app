// ============================================================================
// One interface over both cloud providers.
//
// Everything above this layer (bookshelf, annotations, the UI) talks to
// "the cloud" and never names a provider, so adding Google Drive alongside
// OneDrive didn't mean threading a provider argument through the whole app.
//
// Exactly one provider is connected at a time. Which one is remembered between
// sessions, so the app reconnects to the same drive on the next launch.
// ============================================================================
import * as oneDrive from "./oneDrive.js";
import * as msalAuth from "./msalAuth.js";
import * as googleDrive from "./googleDrive.js";

const PROVIDER_KEY = "shelf.cloudProvider";
const FOLDER_KEY = "shelf.cloudFolder";

export const PROVIDERS = {
  onedrive: {
    id: "onedrive",
    label: "OneDrive",
    auth: msalAuth,
    files: oneDrive,
    // Which field on a book record holds this provider's file id.
    idField: "oneDriveItemId",
  },
  gdrive: {
    id: "gdrive",
    label: "Google Drive",
    auth: googleDrive,
    files: googleDrive,
    idField: "gdriveFileId",
  },
};

let current = null;

function remember(name) {
  try { localStorage.setItem(PROVIDER_KEY, name || ""); } catch (_) {}
}

// ---- Which folder we sync with ---------------------------------------------
// Remembered per provider, because a Google folder id means nothing to
// OneDrive and vice versa.

function folderKeyFor(name) {
  return `${FOLDER_KEY}.${name}`;
}

export function getFolder() {
  if (!current) return null;
  try {
    const raw = localStorage.getItem(folderKeyFor(current.id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function setFolder(folder) {
  if (!current) return;
  try {
    if (folder) localStorage.setItem(folderKeyFor(current.id), JSON.stringify(folder));
    else localStorage.removeItem(folderKeyFor(current.id));
  } catch (_) { /* nothing to do if storage is blocked */ }
  applyFolder();
}

// Push the remembered choice into the provider module, which is what actually
// reads and writes in it.
function applyFolder() {
  if (!current || !current.files.useFolder) return;
  current.files.useFolder(getFolder());
}

export const listFolders = () => need().listFolders();
export const createFolder = (name) => need().createFolder(name);

export function getProviderName() {
  return current ? current.id : null;
}

export function getProviderLabel() {
  return current ? current.label : null;
}

export function providerOf(book) {
  if (book && book.source === "gdrive") return PROVIDERS.gdrive;
  if (book && book.source === "onedrive") return PROVIDERS.onedrive;
  return current;
}

// Restores whichever provider was connected last. Both are asked to
// initialise, because a stored Microsoft session is held by MSAL itself
// rather than by us.
export async function initCloud() {
  let saved = null;
  try { saved = localStorage.getItem(PROVIDER_KEY); } catch (_) {}

  for (const p of Object.values(PROVIDERS)) {
    try { await p.auth.initAuth(); } catch (_) { /* a provider failing to init must not block the app */ }
  }

  if (saved && PROVIDERS[saved] && PROVIDERS[saved].auth.isSignedIn()) {
    current = PROVIDERS[saved];
  } else {
    // Fall back to whichever provider happens to have a live session.
    current = Object.values(PROVIDERS).find((p) => p.auth.isSignedIn()) || null;
  }
  applyFolder();
  return current ? current.auth.getAccount() : null;
}

export async function signIn(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown cloud provider: ${name}`);
  const account = await provider.auth.signIn();
  current = provider;
  remember(name);
  applyFolder();
  return account;
}

export function signOut() {
  if (!current) return;
  current.auth.signOut();
  current = null;
  remember("");
}

export function isSignedIn() {
  return !!current && current.auth.isSignedIn();
}

export function getAccount() {
  return current ? current.auth.getAccount() : null;
}

// ---- File operations, routed to the connected provider ---------------------

function need() {
  if (!current) throw new Error("Not connected to a cloud drive");
  return current.files;
}

export const ensureBooksFolder = () => need().ensureBooksFolder();
export const listBooks = () => need().listBooks();
export const uploadBook = (name, blob) => need().uploadBook(name, blob);
export const downloadJson = (name) => need().downloadJson(name);
export const uploadJson = (name, obj) => need().uploadJson(name, obj);
export const downloadAnnotations = (fileName) => need().downloadAnnotations(fileName);
export const uploadAnnotations = (fileName, doc) => need().uploadAnnotations(fileName, doc);

// A book may have come from a different drive than the one connected now, so
// downloading its bytes follows the book's own source rather than the
// current selection.
export function downloadBookContent(book) {
  const provider = providerOf(book);
  if (!provider) throw new Error("Not connected to a cloud drive");
  const fileId = book[provider.idField];
  if (!fileId) throw new Error("This book has no copy in the connected drive");
  return provider.files.downloadBookContent(fileId);
}
