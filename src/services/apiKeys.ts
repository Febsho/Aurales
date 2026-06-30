function getStoredKey(name: string): string {
  return localStorage.getItem(name)?.trim() || ''
}

export function getTmdbApiKey(): string {
  return getStoredKey('tmdb_api_key') || import.meta.env.VITE_TMDB_API_KEY || ''
}

export function getTvdbApiKey(): string {
  return getStoredKey('tvdb_api_key') || import.meta.env.VITE_TVDB_API_KEY || ''
}
