// ============================================================================
// Carrying the book files themselves between devices, on the free plan.
//
// The obvious home for files is Cloud Storage, which now needs a billed plan
// and a card. Firestore doesn't: the free Spark tier includes a gigabyte of
// document storage, and a book is just bytes. So a book is split into chunks,
// each chunk stored as base64 text in its own document, and reassembled on the
// other device. No card, no second service to set up, and it uses the Firebase
// project that's already connected.
//
// The limits this has to respect:
//   * a single Firestore document caps out just under 1 MiB, so chunks are
//     deliberately well under that once base64's 33% inflation is counted;
//   * the free tier holds 1 GiB in total, so there's a library budget and a
//     per-book ceiling, and anything over it is left for manual import rather
//     than silently filling the quota;
//   * writes are capped per day, but at roughly one write per half-megabyte a
//     whole library is a few thousand writes — nowhere near the ceiling.
// ============================================================================

// 525,000 bytes of book becomes 700,000 base64 characters, comfortably inside
// the ~1,048,576-byte document limit even with field names and overhead.
const CHUNK_BYTES = 525000;

export const MAX_BOOK_BYTES = 45 * 1024 * 1024;        // per book
export const LIBRARY_BUDGET_BYTES = 900 * 1024 * 1024; // leaves headroom under 1 GiB

// ---- base64 helpers ---------------------------------------------------------
// Done in small blocks: String.fromCharCode applied to a multi-megabyte array
// at once overflows the call stack in every browser.

function bytesToBase64(bytes) {
  let binary = "";
  const BLOCK = 8192;
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCK));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---- the index of what's stored --------------------------------------------

export async function listRemoteFiles(s, store, uid) {
  const snap = await s.getDocs(s.collection(store, `users/${uid}/files`));
  const index = new Map();
  snap.forEach((d) => index.set(d.id, d.data()));
  return index;
}

export function totalStoredBytes(index) {
  let total = 0;
  for (const info of index.values()) total += Number(info.size) || 0;
  return total;
}

// ---- moving a book ----------------------------------------------------------

/**
 * Splits a book into chunk documents and writes an index entry describing it.
 * The index entry is written *last*, so a transfer interrupted halfway never
 * advertises a book that can't actually be reassembled.
 */
export async function pushFile(s, store, uid, id, blob, { name, format, onProgress }) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const chunks = Math.ceil(buffer.length / CHUNK_BYTES) || 1;

  for (let i = 0; i < chunks; i++) {
    const slice = buffer.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    await s.setDoc(s.doc(store, `users/${uid}/files/${id}/chunks/${i}`), {
      b64: bytesToBase64(slice),
    });
    if (onProgress) onProgress(i + 1, chunks);
  }

  await s.setDoc(s.doc(store, `users/${uid}/files/${id}`), {
    name: name || "book",
    format: format || "",
    size: blob.size,
    chunks,
    updatedAt: new Date().toISOString(),
  });
  return { chunks, bytes: blob.size };
}

/**
 * Reassembles a book from its chunks. Returns null rather than a corrupt file
 * if any chunk is missing — a half-book is worse than no book, because it
 * would take the place of one that could still be imported by hand.
 */
export async function pullFile(s, store, uid, id, info, onProgress) {
  const snap = await s.getDocs(s.collection(store, `users/${uid}/files/${id}/chunks`));
  const parts = new Map();
  snap.forEach((d) => parts.set(Number(d.id), d.data().b64));
  if (parts.size !== info.chunks) return null;

  const pieces = [];
  for (let i = 0; i < info.chunks; i++) {
    const b64 = parts.get(i);
    if (typeof b64 !== "string") return null;
    pieces.push(base64ToBytes(b64));
    if (onProgress) onProgress(i + 1, info.chunks);
  }
  const mime = info.format === "pdf" ? "application/pdf" : "application/epub+zip";
  return new Blob(pieces, { type: mime });
}

export async function removeFile(s, store, uid, id, info) {
  if (!s.deleteDoc) return;
  for (let i = 0; i < (info?.chunks || 0); i++) {
    await s.deleteDoc(s.doc(store, `users/${uid}/files/${id}/chunks/${i}`)).catch(() => {});
  }
  await s.deleteDoc(s.doc(store, `users/${uid}/files/${id}`)).catch(() => {});
}
