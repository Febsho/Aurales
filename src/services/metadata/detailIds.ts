/** Extract only the requested provider's ID. Canonical app prefixes carry a
 * namespace; removing them before checking the provider confuses unrelated IDs. */
export function parseDetailId(value: unknown, provider: string): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  if (!text || /^(undefined|null|\[object Object\])$/i.test(text)) return undefined
  const canonical = text.match(/^app_(tmdb_movie|tmdb_tv|tmdb|tvdb|movie|show)_(.+)$/i)
  if (canonical) {
    const namespace = canonical[1].toLowerCase()
    const owner = namespace.startsWith('tmdb') ? 'tmdb' : namespace === 'tvdb' ? 'tvdb' : 'imdb'
    return owner === provider ? canonical[2] : undefined
  }
  const prefixed = text.match(/^([a-z]+)[-:](.+)$/i)
  if (prefixed) return prefixed[1].toLowerCase() === provider ? prefixed[2] : undefined
  if (text.startsWith('tt')) return provider === 'imdb' ? text : undefined
  return provider !== 'imdb' && /^\d+$/.test(text) ? text : undefined
}
