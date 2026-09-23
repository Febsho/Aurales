/**
 * Simkl developer credentials - local development only.
 *
 * 1. Copy this file to src/config/simkl.local.ts (gitignored).
 * 2. Paste an AUTH V2 desktop/browser Client ID from https://simkl.com/settings/developer.
 * 3. Never commit simkl.local.ts.
 *
 * For production builds, set VITE_SIMKL_V2_CLIENT_ID.
 * Register http://127.0.0.1/auth/simkl/callback; PKCE means no secret is needed.
 */
export const SIMKL_CONFIG = {
  clientId: "PASTE_SIMKL_CLIENT_ID_HERE",
  clientSecret: "",
  redirectUri: "http://127.0.0.1:42814/auth/simkl/callback",
}
