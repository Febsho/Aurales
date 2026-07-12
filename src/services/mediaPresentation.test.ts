import { describe, expect, it } from 'vitest'
import type { SearchResult } from '../types'
import { cardArtworkUrl, dedupeMediaItems, mediaIdentity } from './mediaPresentation'

function item(type: SearchResult['type'], id: string, provider = 'TMDB'): SearchResult {
  return { type, id, provider, title: `${type}-${id}` }
}

describe('media presentation helpers', () => {
  it('keeps movie and series identities separate when provider ids match', () => {
    expect(mediaIdentity(item('movie', '42'))).not.toBe(mediaIdentity(item('series', '42')))
    expect(dedupeMediaItems([item('movie', '42'), item('series', '42')])).toHaveLength(2)
  })

  it('deduplicates exact catalog identities while preserving source order', () => {
    const first = item('movie', '42')
    const second = { ...first, title: 'duplicate' }
    expect(dedupeMediaItems([first, second, item('movie', '43')]).map((entry) => entry.id)).toEqual(['42', '43'])
  })

  it('uses adaptive TMDB card sizes without changing external artwork', () => {
    const tmdb = 'https://image.tmdb.org/t/p/original/example.jpg'
    expect(cardArtworkUrl(tmdb, 'poster', 'compact')).toContain('/w185/example.jpg')
    expect(cardArtworkUrl(tmdb, 'poster', 'default')).toContain('/w342/example.jpg')
    expect(cardArtworkUrl(tmdb, 'poster', 'huge')).toContain('/w500/example.jpg')
    expect(cardArtworkUrl(tmdb, 'landscape', 'default')).toContain('/w780/example.jpg')
    expect(cardArtworkUrl('https://cdn.example.com/original/example.jpg', 'poster')).toBe('https://cdn.example.com/original/example.jpg')
  })
})
