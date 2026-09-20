// Minimal offline app-shell cache. Book bytes and annotations live in
// IndexedDB (see js/db.js), not here — this just lets the app itself
// (HTML/CSS/JS) load with no network connection.
// Bump this version whenever app files change — the activate handler deletes
// every cache that isn't the current name, which is what forces an already
// installed copy on a tablet to pick up the new files instead of serving the
// old ones forever.
const CACHE_NAME = "shelf-shell-v1.21.0";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/vendor/msal-browser.min.js",
  "./js/vendor/jszip.min.js",
  "./js/vendor/epub.min.js",
  "./js/vendor/pdf.min.js",
  "./js/vendor/pdf.worker.min.js",
  "./js/main.js",
  "./js/gestures.js",
  "./js/reflow.js",
  "./js/ink.js",
  "./js/notes.js",
  "./js/version.js",
  "./js/config.js",
  "./js/msalAuth.js",
  "./js/cloud.js",
  "./js/backup.js",
  "./js/firebaseSync.js",
  "./js/googleDrive.js",
  "./js/oneDrive.js",
  "./js/db.js",
  "./js/annotations.js",
  "./js/readerEpub.js",
  "./js/readerPdf.js",
  "./js/bookshelf.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin app-shell requests; let CDN scripts and Graph/MSAL
  // API calls go straight to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
