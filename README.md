# Shelf — a OneDrive book reader for iPadOS & Android

A single web app that installs like a native app on both iPadOS (Safari) and
Android (Chrome), reads EPUB and PDF, connects to your OneDrive as a
bookshelf, lets you underline text and drop bookmarks, and gives you
undo/redo plus an explicit Save (local instantly, OneDrive on demand).

This doc is the whole setup. Steps 1–2 are one-time. Step 3 is how you use it.

---

## Why a web app, and not a "real" App Store / Play Store app

I can't compile or sign a native iOS app (that requires Xcode on a Mac) or
publish to the App Store / Play Store myself. What I *can* build end-to-end
is this: a Progressive Web App (PWA). Installed via "Add to Home Screen," it
opens full-screen with its own icon, works offline, and behaves like a real
app on both iPadOS and Android — same codebase, no App Store review, and I
was able to finish and hand you the whole thing today. If you later want a
true native app, this is the reference implementation to build from.

---

## 1. Register a free Microsoft Azure app (~5 minutes)

This is what lets *your* copy of the app sign in to *your* Microsoft account.
You're not publishing anything or paying anything — this just gets you a
"Client ID" the app uses to ask Microsoft for permission.

1. Go to https://portal.azure.com and sign in with the same Microsoft
   account you use for OneDrive.
2. Search for **"App registrations"** in the top search bar and open it.
3. Click **New registration**.
   - Name: `Shelf` (or anything you like)
   - Supported account types: **"Personal Microsoft accounts only"**
     (unless you also want to sign in with a work/school account — if so,
     pick "Accounts in any organizational directory and personal Microsoft
     accounts")
   - Redirect URI: leave blank for now — you'll add it in step 1c below.
   - Click **Register**.
4. On the app's **Overview** page, copy the **Application (client) ID**.
   Paste it into `js/config.js` in this project, replacing
   `PASTE-YOUR-AZURE-APP-CLIENT-ID-HERE`.
5. In the left sidebar, click **Authentication** → **Add a platform** →
   **Single-page application (SPA)**.
   - Redirect URI: this must exactly match where you host the app (step 2).
     If you're using GitHub Pages, it'll look like
     `https://<your-username>.github.io/<repo-name>/`
     (note the trailing slash). You can add this now and edit it later if
     the URL changes.
   - Click **Configure**.
6. In the left sidebar, click **API permissions** → **Add a permission** →
   **Microsoft Graph** → **Delegated permissions** → search for and check
   **Files.ReadWrite** → **Add permissions**. (`User.Read` is usually added
   by default already.)

That's it on the Azure side. You don't need a client secret — SPAs don't use one.

If you chose "Personal Microsoft accounts only" in step 3, leave
`js/config.js`'s `authority` as `.../consumers`. If you chose the
work/school + personal option, change it to
`https://login.microsoftonline.com/common`.

## 2. Host the app somewhere with a real HTTPS address

Microsoft's sign-in page refuses to run from a `file://` link, so the app
needs to live at a real URL. The easiest free option is **GitHub Pages**:

1. Create a new GitHub repository and upload everything in this folder
   (`index.html`, `manifest.json`, `sw.js`, `css/`, `js/`, `icons/`) to it.
2. In the repo, go to **Settings → Pages**, set **Source** to your main
   branch (root folder), and save.
3. GitHub gives you a URL like `https://<username>.github.io/<repo>/`.
   Go back to Azure (step 1.5) and make sure the Redirect URI matches this
   *exactly*, including the trailing slash.

(Any static host works the same way — Netlify, Vercel, Azure Static Web
Apps, Cloudflare Pages. GitHub Pages is just the simplest free option.)

## 3. Using the app

- Open the hosted URL on your iPad in Safari, or on Android in Chrome.
- **Install it**: iPadOS — Share button → "Add to Home Screen." Android —
  Chrome will offer "Install app," or use the menu → "Add to Home screen."
  From then on it opens full-screen from its own icon, like any app.
- **Sign in**: tap "Sign in," approve the Microsoft popup.
- **Sync OneDrive**: tap "Sync OneDrive." The app creates a `Books` folder
  in the root of your OneDrive the first time (change the folder name in
  `js/config.js` if you'd rather point it at an existing folder). Drop any
  `.epub` or `.pdf` file in there and hit Sync again to see it appear.
- **Import a file directly**: "Import file..." lets you add an EPUB/PDF
  straight from your iPad/Android's Files app, with no OneDrive account
  needed. It's cached locally exactly like a OneDrive book.
- **Shelves**: the left rail is a scrollable column of shelves — spine-style
  tabs with the name running top-to-bottom, tap one to open it. "All Books,"
  "On This Device," "EPUB," and "PDF" are always there when relevant;
  "Continue Reading" and "OneDrive" appear automatically once they'd have
  something in them. Tap **+** at the bottom of the rail to create your own
  shelf (a reading list, a series, whatever you want to call it), and tap the
  small **+** on any book's cover to file it onto one of your custom shelves.
  Opening a shelf further splits its books into EPUB/PDF sections, so a
  shelf is never just an undifferentiated pile.
- **Read**: tap a book — the cover morphs into the open book with a real
  transition (Apple Books-style), not a hard cut. The page automatically
  fits your screen size — rotate
  the iPad, resize the window, or open it on a phone-sized screen and it
  re-flows/re-fits on the spot.
- **PDF page view** (dropdown in the reader toolbar):
  - *Single page* — one page at a time, fit to your screen.
  - *Two pages (book)* — an open-book spread; page 1 shows alone as a cover,
    then pages pair up (2–3, 4–5, ...) just like a real book. Tap the ‹ / ›
    arrows (or the edges of the page) to turn a full spread at once.
  - *Continuous scroll* — every page in one scrollable column, rendered as
    you scroll to keep it fast on long books.
  - Zoom **−** / **Fit** / **+** sit next to the view picker — Fit snaps
    back to the screen-filling size, +/− zoom in from there. EPUBs use the
    A− / A+ font-size buttons instead, since they reflow rather than zoom.
  - Whatever you pick — page number, view mode, and zoom — is remembered
    per book, so reopening it puts you back exactly where you left off.
- Tap the left/right edges of the page (single/double mode) to turn pages.
- **Underline**: select text with your finger (or Apple Pencil / mouse) the
  way you'd normally select text to copy it — releasing the selection
  underlines it automatically.
- **Bookmark**: tap the 🔖 button to save your exact spot with a label.
- **Undo / Redo**: the ↺ / ↻ buttons undo or redo your last underline or
  bookmark action, any number of steps back.
- **Save**: every edit is saved to the device instantly (so you never lose
  anything, even offline). Tapping **Save** additionally pushes your
  underlines/bookmarks to OneDrive as a small file next to the book (named
  `<bookfile>.annotations.json`), so they follow you to another device. The
  app also tries to save automatically to OneDrive when you background it
  or leave a book.
- The dot next to "Sign in" is amber when you have unsaved-to-OneDrive
  changes, green when signed in and synced.

## How your data is stored

- Every book's bytes and every annotation live in the browser's local
  database (IndexedDB) the moment you open or import them — this is what
  makes offline reading and instant undo/save possible, on both iPadOS and
  Android, with or without a Microsoft account.
- When signed in, annotations additionally sync to a JSON sidecar file
  next to each book in your OneDrive `Books` folder — nothing about your
  book files themselves is modified.
- If you use this on two devices, both signed in to the same OneDrive
  account, opening a book reconciles with whichever annotation set was
  saved most recently.

## Known limitations, honestly

- PDF underlining stores position as page + rectangle, which is precise
  but PDFs aren't reflowable, so it won't survive re-flowing/resizing the
  way EPUB underlines do. Text selection also won't work on scanned PDFs
  that have no embedded text layer (that would need OCR, which isn't
  included here).
- This is a PWA, not a listed native app — there's no App Store/Play Store
  presence, no push notifications, and iOS Safari PWAs get less background
  processing time than a native app, so "auto-save to OneDrive on
  background" is best-effort, not guaranteed — the manual Save button is
  the reliable path.
- A true native Android app (Kotlin, in Android Studio, distributed as an
  APK or on Google Play) is a separate build I haven't done — this covers
  Android via the same installable web app, which is the part I could
  actually finish and hand you working today.
