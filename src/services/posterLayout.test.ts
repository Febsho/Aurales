import { describe, expect, it } from 'vitest'
import { getPosterArtworkCandidate } from './posterLayout'

describe('getPosterArtworkCandidate', () => {
  it('prefers clean artwork so app-composed logos stay on a separate layer', () => {
    expect(getPosterArtworkCandidate('poster', 'configured-poster.jpg', 'clean-poster.jpg', 'backdrop.jpg'))
      .toBe('clean-poster.jpg')
  })

  it('uses the configured poster if no clean alternate is available', () => {
    expect(getPosterArtworkCandidate('poster', 'configured-poster.jpg', undefined, 'backdrop.jpg'))
      .toBe('configured-poster.jpg')
  })

  it('falls back to clean poster and then backdrop when a catalog has no poster', () => {
    expect(getPosterArtworkCandidate('poster', undefined, 'clean-poster.jpg', 'backdrop.jpg'))
      .toBe('clean-poster.jpg')
    expect(getPosterArtworkCandidate('poster', undefined, undefined, 'backdrop.jpg'))
      .toBe('backdrop.jpg')
  })

  it('uses the backdrop when that artwork style is selected', () => {
    expect(getPosterArtworkCandidate('backdrop', 'poster.jpg', 'clean-poster.jpg', 'backdrop.jpg'))
      .toBe('backdrop.jpg')
  })
})
