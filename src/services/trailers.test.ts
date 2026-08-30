import { describe, expect, it } from 'vitest'
import { extractYoutubeFallback } from './trailers'

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
