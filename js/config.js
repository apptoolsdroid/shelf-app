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

  // The OneDrive folder (relative to your OneDrive root) that acts as your
  // bookshelf. Any .epub or .pdf file placed in this folder shows up in the app.
  // Change this if you want to point it at a different folder.
  booksFolderPath: "Books",
};
