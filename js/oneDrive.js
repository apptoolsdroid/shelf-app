// ============================================================================
// Microsoft Graph calls against OneDrive: list the bookshelf folder, download
// book files, and read/write the small JSON "sidecar" file that holds each
// book's underlines/bookmarks.
// ============================================================================
import { CONFIG } from "./config.js";
import { getAccessToken } from "./msalAuth.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

async function graphFetch(path, options = {}) {
  const token = await getAccessToken();
  const resp = await fetch(`${GRAPH}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OneDrive request failed (${resp.status}): ${body || resp.statusText}`);
  }
  return resp;
}

function encodedFolderPath() {
  return CONFIG.booksFolderPath.split("/").map(encodeURIComponent).join("/");
}

// Ensures the configured bookshelf folder exists in OneDrive, creating it
// (in the drive root) the first time the app runs if it's missing.
export async function ensureBooksFolder() {
  try {
    await graphFetch(`/me/drive/root:/${encodedFolderPath()}`);
  } catch (err) {
    // Not found — create it.
    await graphFetch(`/me/drive/root/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: CONFIG.booksFolderPath,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    });
  }
}

// Lists every .epub / .pdf in the bookshelf folder.
export async function listBooks() {
  const resp = await graphFetch(
    `/me/drive/root:/${encodedFolderPath()}:/children?$select=id,name,size,file,lastModifiedDateTime`
  );
  const data = await resp.json();
  return (data.value || []).filter((item) => {
    const name = (item.name || "").toLowerCase();
    return item.file && (name.endsWith(".epub") || name.endsWith(".pdf"));
  });
}

// Downloads a book's raw bytes as a Blob.
export async function downloadBookContent(itemId) {
  const resp = await graphFetch(`/me/drive/items/${itemId}/content`);
  return await resp.blob();
}

function sidecarName(bookFileName) {
  return `${bookFileName}.annotations.json`;
}

// Reads the annotations sidecar for a book. Returns null if it doesn't exist yet.
export async function downloadAnnotations(bookFileName) {
  try {
    const resp = await graphFetch(
      `/me/drive/root:/${encodedFolderPath()}/${encodeURIComponent(sidecarName(bookFileName))}:/content`
    );
    return await resp.json();
  } catch (err) {
    return null; // No sidecar yet — that's fine, treat as "no annotations".
  }
}

// Writes (creates or overwrites) the annotations sidecar for a book.
// Sidecars are small JSON, well under Graph's 4MB simple-upload limit.
export async function uploadAnnotations(bookFileName, annotationsDoc) {
  const path = `/me/drive/root:/${encodedFolderPath()}/${encodeURIComponent(sidecarName(bookFileName))}:/content`;
  await graphFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(annotationsDoc, null, 2),
  });
}

// ---- Parity helpers so cloud.js can treat both drives the same -------------

// Uploads a book's bytes into the bookshelf folder. This is what makes a book
// imported on one device show up on another.
export async function uploadBook(name, blob) {
  const path = `/me/drive/root:/${encodedFolderPath()}/${encodeURIComponent(name)}:/content`;
  const resp = await graphFetch(path, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  const item = await resp.json();
  return { id: item.id, name: item.name };
}

// Generic small-JSON read/write in the bookshelf folder, used for the shelf
// layout manifest as well as annotation sidecars.
export async function downloadJson(name) {
  try {
    const resp = await graphFetch(
      `/me/drive/root:/${encodedFolderPath()}/${encodeURIComponent(name)}:/content`
    );
    return await resp.json();
  } catch (err) {
    return null; // Not there yet.
  }
}

export async function uploadJson(name, obj) {
  await graphFetch(
    `/me/drive/root:/${encodedFolderPath()}/${encodeURIComponent(name)}:/content`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj, null, 2),
    }
  );
}
