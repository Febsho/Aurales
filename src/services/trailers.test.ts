import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('./cache/sqliteCache', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}))

import { extractYoutubeFallback, getTrailerSource, TRAILERIO_MANIFEST_URL } from './trailers'

beforeEach(() => invoke.mockReset())

describe('Trailerio source', () => {
  it('uses the manifest addon as the primary exact-ID source', async () => {
    invoke.mockResolvedValue(JSON.stringify({
      meta: {
        links: [
          { trailers: 'https://cdn.example/trailer.mp4', provider: 'Plex 1080p' },
          { trailers: 'https://cdn.example/master.m3u8', provider: 'Apple TV 1080p' },
        ],
      },
    }))

    const source = await getTrailerSource({
      type: 'movie',
      tmdbId: 603,
      imdbId: 'tt0133093',
      title: 'The Matrix',
      year: 1999,
    })

    expect(TRAILERIO_MANIFEST_URL).toBe('https://trailerio.cc/manifest.json')
    expect(invoke).toHaveBeenCalledWith('http_get_text', {
      url: 'https://trailerio.cc/meta/movie/tt0133093.json',
    })
    expect(source).toMatchObject({
      source: 'trailerio',
      key: 'trailerio:tt0133093',
      directUrl: 'https://cdn.example/master.m3u8',
    })
  })
})

describe('YouTube trailer fallback', () => {
  it('requires the full title instead of matching a franchise name', () => {
    const html = [
      '"videoId":"oldSpider01" "title":{"runs":[{"text":"Spider-Man: No Way Home - Official Trailer"',
      '"videoId":"newSpider01" "title":{"runs":[{"text":"Spider-Man: Brand New Day | Official Trailer"',
    ].join(' ')

    expect(extractYoutubeFallback(html, 'Spider-Man: Brand New Day')?.key).toBe('newSpider01')
  })

  it('does not accept an unrelated watch link when no verified title is present', () => {
    expect(extractYoutubeFallback('watch?v=oldSpider01', 'Spider-Man: Brand New Day')).toBeNull()
  })
})
