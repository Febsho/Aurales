import { describe, expect, it } from 'vitest'
import { detectAudioFormats, isEncodedAudioOutput, type NativePlayerDebugSnapshot } from './playerDebug'

function snapshot(overrides: Partial<NativePlayerDebugSnapshot> = {}): NativePlayerDebugSnapshot {
  return {
    capturedAt: '', fileFormat: null, videoCodec: null, videoFormat: null, videoParams: null,
    hardwareDecoder: null, estimatedFps: null, displayFps: null, audioCodec: null,
    audioCodecName: null, audioParams: null, audioOutParams: null, audioOutput: null,
    audioDevice: null, tracks: [], ...overrides,
  }
}

describe('player format diagnostics', () => {
  it('detects Atmos and its TrueHD carrier from the active track', () => {
    const formats = detectAudioFormats(snapshot({
      audioCodecName: 'truehd',
      tracks: [{ type: 'audio', selected: true, title: 'English TrueHD 7.1 Atmos' }],
    }))
    expect(formats.find((format) => format.id === 'atmos')?.state).toBe('detected')
    expect(formats.find((format) => format.id === 'truehd')?.state).toBe('detected')
  })

  it('does not claim Atmos when only its possible carrier is active', () => {
    const formats = detectAudioFormats(snapshot({ audioCodecName: 'eac3' }))
    expect(formats.find((format) => format.id === 'atmos')?.state).toBe('carrier')
    expect(formats.find((format) => format.id === 'eac3')?.state).toBe('detected')
  })

  it('detects DTS:X and encoded passthrough output', () => {
    const value = snapshot({
      tracks: [{ type: 'audio', selected: true, codec: 'dts-hd', title: 'DTS:X 7.1' }],
      audioOutParams: { format: 'spdif-dts-hd' },
    })
    expect(detectAudioFormats(value).find((format) => format.id === 'dtsx')?.state).toBe('detected')
    expect(isEncodedAudioOutput(value)).toBe(true)
  })
})
