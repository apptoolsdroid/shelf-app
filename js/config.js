// ============================================================================
// CONFIG — fill this in once after you register a free Azure AD app.
// See README.md for the exact click-by-click steps.
// ============================================================================
export const CONFIG = {
  // Paste the "Application (client) ID" from your Azure App Registration here.
  clientId: "PASTE-YOUR-AZURE-APP-CLIENT-ID-HERE",

  // "consumers" = personal Microsoft accounts (outlook.com, hotmail, live).
  // Use "common" instead if you also want to allow work/school accounts.
  authority: "https://login.microsoftonline.com/consumers",

  // Must exactly match a "Redirect URI" (SPA platform) registered in Azure.
  // Leave this as-is — it auto-detects wherever you end up hosting the app.
  get redirectUri() {
    return window.location.origin + window.location.pathname.replace(/index\.html$/, "");
  },

  // Delegated Graph scopes this app requests.
  scopes: ["User.Read", "Files.ReadWrite"],

  // ---- Google Drive (optional second provider) ----------------------------
  // Leave this alone if you only use OneDrive. To sync with Google Drive
  // instead, create an OAuth client ID in the Google Cloud Console and paste
  // it here — README section 1b has the click-by-click steps.
  google: {
    clientId: "PASTE-YOUR-GOOGLE-OAUTH-CLIENT-ID-HERE",

    // "drive.file" lets the app see only the files it created itself, which is
    // the least invasive scope that still syncs everything between your own
    // devices. Change it to "https://www.googleapis.com/auth/drive" if you also
    // want the app to pick up books you drop into the folder by hand.
    scope: "https://www.googleapis.com/auth/drive.file",
  },

  // The cloud folder (in the drive root) that acts as your
  // bookshelf. Any .epub or .pdf file placed in this folder shows up in the app.
  // Change this if you want to point it at a different folder.
  booksFolderPath: "Books",
};
