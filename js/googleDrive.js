// ============================================================================
// Google Drive provider: sign-in via Google Identity Services, plus the Drive
// v3 calls the app needs — find/create the books folder, list it, download a
// book, and read/write the small JSON sidecars (annotations, shelf layout).
//
// Mirrors the shape of oneDrive.js + msalAuth.js so cloud.js can treat the two
// providers interchangeably.
//
// Scope note: the default `drive.file` scope only grants access to files this
// app itself created, which is the least invasive option that still syncs
// everything between your own devices. If you want the app to also pick up
// files you drop into the folder yourself from a computer, widen
// CONFIG.google.scope — see README.
// ============================================================================
import { CONFIG } from "./config.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_KEY = "shelf.gdrive.token";

let tokenClient = null;
let accessToken = null;
let expiresAt = 0;
let account = null; // { username }
let booksFolderId = null;

function loadStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Treat a token as usable only with a minute to spare, so a request can't
    // expire in flight.
    if (saved.expiresAt && saved.expiresAt > Date.now() + 60000) {
      accessToken = saved.accessToken;
      expiresAt = saved.expiresAt;
      account = saved.account || null;
    }
  } catch (_) { /* unreadable storage just means signing in again */ }
}

function storeToken() {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken, expiresAt, account }));
  } catch (_) { /* private mode — the session still works, it just won't persist */ }
}

// Google's auth library has to come from Google's own origin; it can't be
// bundled. It's loaded on demand, so the app is still fully usable offline for
// anyone who never touches Google Drive.
function loadGis() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Couldn't load Google sign-in")));
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't reach Google sign-in — check your connection"));
    document.head.appendChild(s);
  });
}

export async function initAuth() {
  loadStoredToken();
  return account;
}

export function isSignedIn() {
  return !!accessToken && expiresAt > Date.now();
}

export function getAccount() {
  return account;
}

function requestToken({ silent }) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      accessToken = resp.access_token;
      expiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
      storeToken();
      resolve(accessToken);
    };
    // An empty prompt reuses an existing Google session without showing the
    // consent screen again; "consent" forces the full dialog.
    tokenClient.requestAccessToken({ prompt: silent ? "" : "consent" });
  });
}

export async function signIn() {
  if (!CONFIG.google || !CONFIG.google.clientId || CONFIG.google.clientId.startsWith("PASTE-")) {
    throw new Error("Add your Google client ID to js/config.js first (see README)");
  }
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.google.clientId,
      scope: CONFIG.google.scope,
      callback: () => {},
    });
  }
  await requestToken({ silent: false });
  account = await fetchUserInfo().catch(() => ({ username: "Google Drive" }));
  storeToken();
  return account;
}

export function signOut() {
  try {
    if (accessToken && window.google && window.google.accounts) {
      window.google.accounts.oauth2.revoke(accessToken, () => {});
    }
  } catch (_) { /* revocation is best effort */ }
  accessToken = null;
  expiresAt = 0;
  account = null;
  booksFolderId = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

export async function getAccessToken() {
  if (isSignedIn()) return accessToken;
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.google.clientId,
      scope: CONFIG.google.scope,
      callback: () => {},
    });
  }
  // Try to refresh without bothering the user; fall back to the full prompt.
  try {
    return await requestToken({ silent: true });
  } catch (_) {
    return await requestToken({ silent: false });
  }
}

async function fetchUserInfo() {
  const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error("userinfo failed");
  const data = await resp.json();
  return { username: data.email || data.name || "Google Drive" };
}

async function driveFetch(url, options = {}) {
  const token = await getAccessToken();
  const resp = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Google Drive request failed (${resp.status}): ${body || resp.statusText}`);
  }
  return resp;
}

const q = (s) => encodeURIComponent(s);

export async function ensureBooksFolder() {
  if (booksFolderId) return booksFolderId;
  const name = CONFIG.booksFolderPath.split("/").pop();
  const query = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  const resp = await driveFetch(`${DRIVE}/files?q=${q(query)}&fields=files(id,name)&spaces=drive`);
  const data = await resp.json();
  if (data.files && data.files.length > 0) {
    booksFolderId = data.files[0].id;
    return booksFolderId;
  }
  const created = await driveFetch(`${DRIVE}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  booksFolderId = (await created.json()).id;
  return booksFolderId;
}

export async function listBooks() {
  const folderId = await ensureBooksFolder();
  const query = `'${folderId}' in parents and trashed=false`;
  const resp = await driveFetch(
    `${DRIVE}/files?q=${q(query)}&fields=files(id,name,modifiedTime,size)&pageSize=1000&spaces=drive`
  );
  const data = await resp.json();
  return (data.files || [])
    .filter((f) => /\.(epub|pdf)$/i.test(f.name))
    .map((f) => ({ id: f.id, name: f.name, lastModifiedDateTime: f.modifiedTime }));
}

export async function downloadBookContent(fileId) {
  const resp = await driveFetch(`${DRIVE}/files/${fileId}?alt=media`);
  return await resp.blob();
}

async function findFileByName(name) {
  const folderId = await ensureBooksFolder();
  const query = `'${folderId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  const resp = await driveFetch(`${DRIVE}/files?q=${q(query)}&fields=files(id,name)&spaces=drive`);
  const data = await resp.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

// Creates or replaces a file in the books folder. Drive has no "write by
// path", so an existing file has to be located by name and updated in place —
// otherwise every save would leave another copy behind.
async function putFile(name, body, contentType) {
  const existingId = await findFileByName(name);
  if (existingId) {
    await driveFetch(`${UPLOAD}/files/${existingId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": contentType },
      body,
    });
    return existingId;
  }

  const folderId = await ensureBooksFolder();
  const boundary = `shelf${Date.now()}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const parts = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    body,
    `\r\n--${boundary}--`,
  ]);
  const resp = await driveFetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: parts,
  });
  return (await resp.json()).id;
}

export async function uploadBook(name, blob) {
  const id = await putFile(name, blob, blob.type || "application/octet-stream");
  return { id, name };
}

export async function downloadJson(name) {
  const id = await findFileByName(name);
  if (!id) return null;
  const resp = await driveFetch(`${DRIVE}/files/${id}?alt=media`);
  return await resp.json();
}

export async function uploadJson(name, obj) {
  await putFile(name, new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }), "application/json");
}

export async function downloadAnnotations(bookFileName) {
  return await downloadJson(`${bookFileName}.annotations.json`);
}

export async function uploadAnnotations(bookFileName, annotationsDoc) {
  await uploadJson(`${bookFileName}.annotations.json`, annotationsDoc);
}
