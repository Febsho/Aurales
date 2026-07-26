import { describe, expect, it } from 'vitest'
import { detectStreamFeatures } from './streamFeatures'

const ids = (name: string, extra: Record<string, unknown> = {}) =>
  detectStreamFeatures({ name, ...extra }).map((feature) => feature.id)

describe('detectStreamFeatures', () => {
  it('reads the full spec off a remux release name', () => {
    expect(ids('House.of.the.Dragon.S01E01.2160p.UHD.BluRay.REMUX.HEVC.DV.TrueHD.7.1.Atmos-GRP'))
      .toEqual(['4k', 'dv', 'atmos', 'truehd', '71'])
  })

  it('keeps the two Dolby lockups adjacent instead of splitting them with HDR10', () => {
    expect(ids('Movie.2026.2160p.WEB-DL.DV.HDR10.DDP5.1.Atmos-GRP'))
      .toEqual(['4k', 'hdr10', 'dv', 'atmos', '51'])
  })

  it('prefers the most specific match per group', () => {
    expect(ids('Show.S01E01.1080p.BluRay.x265.HDR10+.DTS-HD.MA.7.1'))
      .toEqual(['1080p', 'hdr10plus', 'dtshd', '71'])
  })

  it('splits dot- and underscore-separated tokens', () => {
    expect(ids('Movie_2026_Dolby.Vision_TrueHD_5.1')).toEqual(['dv', 'truehd', '51'])
  })

  it('does not repeat the Dolby lockup for Atmos carried in DD+', () => {
    expect(ids('Movie.2160p.DDP5.1.Atmos')).toEqual(['4k', 'atmos', '51'])
  })

  it('marks CC when the stream carries subtitles', () => {
    expect(ids('Movie.1080p.SDH', { subtitles: [{ id: 'a', url: 'u', lang: 'en' }] }))
      .toEqual(['1080p', 'cc', 'sdh'])
  })

  it('returns nothing for a nameless or uninformative stream', () => {
    expect(detectStreamFeatures(null)).toEqual([])
    expect(ids('Some Release')).toEqual([])
  })
})
