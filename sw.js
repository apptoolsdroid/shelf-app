// Minimal offline app-shell cache. Book bytes and annotations live in
// IndexedDB (see js/db.js), not here — this just lets the app itself
// (HTML/CSS/JS) load with no network connection.
// Bump this version whenever app files change — the activate handler deletes
// every cache that isn't the current name, which is what forces an already
// installed copy on a tablet to pick up the new files instead of serving the
// old ones forever.
const CACHE_NAME = "shelf-shell-v1.34.0";
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
  "./js/fileSync.js",
  "./js/pageTurn.js",
  "./js/shortcuts.js",
  "./js/sound.js",
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

// How long to wait for the network before falling back to the cached copy.
// Long enough for a slow tablet on hotel wifi, short enough that an offline
// start doesn't feel broken.
const NETWORK_TIMEOUT_MS = 3500;

function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("network timeout")), NETWORK_TIMEOUT_MS);
    fetch(request).then(
      (resp) => { clearTimeout(timer); resolve(resp); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Network first, cache as the fallback.
//
// This used to be the other way round — cache first, refresh in the
// background — which is faster but means that after uploading a new version
// of the site you still get the old one, because the old copy is handed over
// before the new one is even requested. The version in the top bar then reads
// as the previous release and the app looks like it never updated, which is
// exactly the confusion it exists to prevent. Correctness about which build
// you're running matters more here than shaving a few hundred milliseconds
// off a start that is already fast.
//
// Offline still works: every shell file is precached at install, and anything
// the network can't produce is served from there.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin app-shell requests; let CDN scripts and Graph/MSAL
  // API calls go straight to the network.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  event.respondWith((async () => {
    try {
      const resp = await fromNetwork(event.request);
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
      }
      return resp;
    } catch (err) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      // A page request with nothing cached under that exact URL should still
      // get the app rather than the browser's offline error page.
      if (event.request.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
