// ============================================================================
// Microsoft sign-in (MSAL). Handles login, token acquisition/refresh.
// ============================================================================
import { CONFIG } from "./config.js";

let msalInstance = null;
let activeAccount = null;

export async function initAuth() {
  msalInstance = new msal.PublicClientApplication({
    auth: {
      clientId: CONFIG.clientId,
      authority: CONFIG.authority,
      redirectUri: CONFIG.redirectUri,
    },
    cache: {
      cacheLocation: "localStorage",
      storeAuthStateInCookie: false,
    },
  });

  await msalInstance.initialize();

  // Complete any redirect flow that's in progress.
  const result = await msalInstance.handleRedirectPromise();
  if (result && result.account) {
    activeAccount = result.account;
  } else {
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length > 0) activeAccount = accounts[0];
  }
  return activeAccount;
}

export function isSignedIn() {
  return !!activeAccount;
}

export function getAccount() {
  return activeAccount;
}

export async function signIn() {
  if (CONFIG.clientId.includes("PASTE-YOUR-AZURE-APP")) {
    throw new Error(
      "OneDrive isn't configured yet. Open js/config.js and paste in your " +
      "Azure App Client ID (see README.md for the 5-minute setup steps)."
    );
  }
  const loginResp = await msalInstance.loginPopup({ scopes: CONFIG.scopes });
  activeAccount = loginResp.account;
  return activeAccount;
}

export function signOut() {
  if (!msalInstance || !activeAccount) return;
  msalInstance.logoutPopup({ account: activeAccount });
  activeAccount = null;
}

// Returns a valid access token, silently refreshing if possible, falling
// back to an interactive popup if a refresh can't be done silently.
export async function getAccessToken() {
  if (!msalInstance || !activeAccount) throw new Error("Not signed in to Microsoft.");
  try {
    const resp = await msalInstance.acquireTokenSilent({
      scopes: CONFIG.scopes,
      account: activeAccount,
    });
    return resp.accessToken;
  } catch (err) {
    const resp = await msalInstance.acquireTokenPopup({ scopes: CONFIG.scopes });
    return resp.accessToken;
  }
}
