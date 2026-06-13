/**
 * Simkl developer credentials - local development only.
 *
 * 1. Copy this file to src/config/simkl.local.ts (gitignored).
 * 2. Paste your Client ID from https://simkl.com/settings/developer.
 * 3. Never commit simkl.local.ts.
 *
 * For production builds, set VITE_SIMKL_CLIENT_ID.
 * Aurales uses Simkl's PIN flow, so no client secret or redirect URI is needed.
 */
export const SIMKL_CONFIG = {
  clientId: "PASTE_SIMKL_CLIENT_ID_HERE",
  clientSecret: "",
  redirectUri: "urn:ietf:wg:oauth:2.0:oob",
}
