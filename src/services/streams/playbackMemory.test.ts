import { beforeEach, describe, expect, it, vi } from 'vitest'
import { playbackMemoryScore, playbackPreferenceFromStream, recordPlaybackPreference, loadPlaybackMemory } from './playbackMemory'

const stream = { addonId: 'aiostreams-personal-42', title: 'Example Show S01E02 2160p DV WEB-DL HEVC English', url: 'https://private.example/stream?token=secret' }

describe('playback memory', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn() })
  })

  it('persists sanitized release characteristics without a stream URL', () => {
    recordPlaybackPreference('series:42', stream, 'success', { audioLanguage: 'en' })
    const preference = loadPlaybackMemory()['series:42']
    expect(preference.addonId).toBe('aiostreams-personal-42')
    expect(preference.resolution).toBe('2160p')
    expect(JSON.stringify(preference)).not.toContain('private.example')
    expect(JSON.stringify(preference)).not.toContain('secret')
  })

  it('adds a bounded preference bonus only for compatible characteristics', () => {
    const memory = playbackPreferenceFromStream(stream)
    memory.successCount = 3
    const compatible = playbackMemoryScore(stream, [memory])
    const incompatible = playbackMemoryScore({ ...stream, addonId: 'other', title: 'Example Show S01E02 720p WEBRip AAC' }, [memory])
    expect(compatible.score).toBeGreaterThan(incompatible.score)
    expect(compatible.score).toBeLessThanOrEqual(45)
  })
})
