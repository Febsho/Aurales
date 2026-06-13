const BUILTIN_TMDB_API_KEY = '64e0744d0e17577a503c56855c3fb99d'
const BUILTIN_TVDB_API_KEY = '1850838b-48c6-4d38-bc8b-e13f8bec17df'

function getStoredKey(name: string): string {
  return localStorage.getItem(name)?.trim() || ''
}

export function getTmdbApiKey(): string {
  return getStoredKey('tmdb_api_key') || import.meta.env.VITE_TMDB_API_KEY || BUILTIN_TMDB_API_KEY
}

export function getTvdbApiKey(): string {
  return getStoredKey('tvdb_api_key') || import.meta.env.VITE_TVDB_API_KEY || BUILTIN_TVDB_API_KEY
}
