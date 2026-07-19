function getStoredKey(name: string): string {
  return localStorage.getItem(name)?.trim() || ''
}

// Built-in metadata keys shipped with the app so catalogs work out of the box on
// a fresh device with nothing configured. TMDB/TVDB keys are client-side keys —
// the request goes straight from the app to the provider, so the key is present
// in every distributed build regardless. Baking a default here (rather than only
// reading VITE_* at build time) guarantees the "built-in key" the Settings UI
// promises survives fresh clones and CI builds where .env is absent (.env is
// gitignored). Resolution order: user-provided (Settings) → build-time env → built-in.
const BUILTIN_TMDB_API_KEY = '64e0744d0e17577a503c56855c3fb99d'
const BUILTIN_TVDB_API_KEY = '0802723a-231e-4f0c-bf30-58e95334954a'

export function getTmdbApiKey(): string {
  return getStoredKey('tmdb_api_key') || import.meta.env.VITE_TMDB_API_KEY || BUILTIN_TMDB_API_KEY
}

export function getTvdbApiKey(): string {
  return getStoredKey('tvdb_api_key') || import.meta.env.VITE_TVDB_API_KEY || BUILTIN_TVDB_API_KEY
}

/** True when an effective TMDB key exists (user-provided, build-time, or built-in). */
export function hasTmdbApiKey(): boolean {
  return getTmdbApiKey().trim().length > 0
}

/** True when an effective TVDB key exists (user-provided, build-time, or built-in). */
export function hasTvdbApiKey(): boolean {
  return getTvdbApiKey().trim().length > 0
}
