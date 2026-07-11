import { describe, expect, it } from 'vitest'
import { rankStreams, scoreStream, type SmartStream } from './smartScoring'
import { streamFingerprint } from './reliabilityHistory'

const stream = (title: string, addonId = 'addon'): SmartStream => ({ title, addonId, addonName: addonId, url: `https://example.com/${encodeURIComponent(title)}.mp4` })
const context = { title: 'Example Movie', mode: 'best' as const, player: 'mpv' as const }

describe('smart stream scoring', () => {
  it('ranks a matching 1080p web source above cam and fake sources', () => {
    const ranked = rankStreams([stream('Example Movie trailer 2160p'), stream('Example Movie CAM 720p'), stream('Example Movie 1080p WEB-DL')], context)
    expect(ranked[0].stream.title).toContain('WEB-DL')
  })

  it('strongly penalizes prior failures and bad reports', () => {
    const candidate = stream('Example Movie 1080p')
    const history = { [streamFingerprint(candidate)]: { success: 0, failedStart: 2, unstable: 1, reportedBad: 1, preferred: 0, updatedAt: 1 } }
    expect(scoreStream(candidate, { ...context, history }).score).toBeLessThan(scoreStream(candidate, context).score - 100)
  })

  it('rewards preferred audio language matches', () => {
    const english = scoreStream(stream('Example Movie 1080p English'), { ...context, preferredAudio: ['en'] })
    const german = scoreStream(stream('Example Movie 1080p German'), { ...context, preferredAudio: ['en'] })
    expect(english.score).toBeGreaterThan(german.score)
  })
})
