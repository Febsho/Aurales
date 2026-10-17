import { describe, expect, it } from 'vitest'
import { audioLanguageOrder, selectStartupSubtitle } from './languagePreferences'

const normalize = (language?: string) => language || null
const tracks = [
  { id: 1, lang: 'de', label: 'German' },
  { id: 4, lang: 'en', label: 'English Forced', forced: true },
  { id: 2, lang: 'en', label: 'English SDH' },
  { id: 3, lang: 'en', label: 'English' },
]

describe('playback language preferences', () => {
  it('only applies matching-audio hide mode when both languages match', () => {
    expect(selectStartupSubtitle({ tracks, preferred: ['de', 'en'], preferSdh: false, mode: 'hide', selectedAudioLanguage: 'en', normalize }))
      .toMatchObject({ kind: 'track', track: { id: 1 } })
    expect(selectStartupSubtitle({ tracks, preferred: ['en'], preferSdh: false, mode: 'hide', selectedAudioLanguage: 'en', normalize }))
      .toEqual({ kind: 'off' })
  })

  it('chooses forced or SDH variants only when requested', () => {
    expect(selectStartupSubtitle({ tracks, preferred: ['en'], preferSdh: false, mode: 'show', selectedAudioLanguage: 'de', normalize }))
      .toMatchObject({ kind: 'track', track: { id: 3 } })
    expect(selectStartupSubtitle({ tracks, preferred: ['en'], preferSdh: true, mode: 'show', selectedAudioLanguage: 'de', normalize }))
      .toMatchObject({ kind: 'track', track: { id: 2 } })
    expect(selectStartupSubtitle({ tracks, preferred: ['en'], preferSdh: false, mode: 'forced', selectedAudioLanguage: 'en', normalize }))
      .toMatchObject({ kind: 'track', track: { id: 4 } })
  })

  it('prioritizes Japanese audio only for anime in sub mode', () => {
    expect(audioLanguageOrder(['en', 'de'], true, 'sub')).toEqual(['ja', 'en', 'de'])
    expect(audioLanguageOrder(['en', 'de'], true, 'dub')).toEqual(['en', 'de'])
    expect(audioLanguageOrder(['en', 'de'], false, 'sub')).toEqual(['en', 'de'])
  })
})
