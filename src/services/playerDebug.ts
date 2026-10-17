import { getPlayerProperty } from './player'

export interface PlayerDebugTrack {
  id?: number
  type?: string
  selected?: boolean
  lang?: string
  title?: string
  codec?: string
  'decoder-desc'?: string
  'demux-channel-count'?: number
  'demux-channels'?: string
  'demux-samplerate'?: number
}

export interface NativePlayerDebugSnapshot {
  capturedAt: string
  fileFormat: unknown
  videoCodec: unknown
  videoFormat: unknown
  videoParams: unknown
  hardwareDecoder: unknown
  estimatedFps: unknown
  displayFps: unknown
  audioCodec: unknown
  audioCodecName: unknown
  audioParams: unknown
  audioOutParams: unknown
  audioOutput: unknown
  audioDevice: unknown
  tracks: PlayerDebugTrack[]
}

export type FormatDetectionState = 'detected' | 'carrier' | 'not-detected'

export interface AudioFormatDetection {
  id: string
  label: string
  state: FormatDetectionState
  detail?: string
}

const DEBUG_PROPERTIES = {
  fileFormat: 'file-format',
  videoCodec: 'video-codec',
  videoFormat: 'video-format',
  videoParams: 'video-params',
  hardwareDecoder: 'hwdec-current',
  estimatedFps: 'estimated-vf-fps',
  displayFps: 'display-fps',
  audioCodec: 'audio-codec',
  audioCodecName: 'audio-codec-name',
  audioParams: 'audio-params',
  audioOutParams: 'audio-out-params',
  audioOutput: 'current-ao',
  audioDevice: 'audio-device',
  tracks: 'track-list',
} as const

export async function collectNativePlayerDebugSnapshot(): Promise<NativePlayerDebugSnapshot> {
  const entries = await Promise.all(Object.entries(DEBUG_PROPERTIES).map(async ([key, property]) => {
    const value = await getPlayerProperty(property).catch(() => null)
    return [key, value] as const
  }))
  const values = Object.fromEntries(entries) as Record<keyof typeof DEBUG_PROPERTIES, unknown>
  return {
    capturedAt: new Date().toISOString(),
    fileFormat: values.fileFormat,
    videoCodec: values.videoCodec,
    videoFormat: values.videoFormat,
    videoParams: values.videoParams,
    hardwareDecoder: values.hardwareDecoder,
    estimatedFps: values.estimatedFps,
    displayFps: values.displayFps,
    audioCodec: values.audioCodec,
    audioCodecName: values.audioCodecName,
    audioParams: values.audioParams,
    audioOutParams: values.audioOutParams,
    audioOutput: values.audioOutput,
    audioDevice: values.audioDevice,
    tracks: Array.isArray(values.tracks) ? values.tracks as PlayerDebugTrack[] : [],
  }
}

function selectedAudioText(snapshot: NativePlayerDebugSnapshot, sourceHint = ''): string {
  const selected = snapshot.tracks.find((track) => track.type === 'audio' && track.selected)
  return [
    snapshot.audioCodec,
    snapshot.audioCodecName,
    selected?.codec,
    selected?.title,
    selected?.['decoder-desc'],
    sourceHint,
  ].filter(Boolean).join(' ').toLowerCase()
}

export function detectAudioFormats(snapshot: NativePlayerDebugSnapshot, sourceHint = ''): AudioFormatDetection[] {
  const text = selectedAudioText(snapshot, sourceHint)
  const hasAtmos = /\batmos\b/.test(text)
  const hasDtsX = /\bdts[ ._:-]?(?:x|xll)\b/.test(text)
  const hasTrueHd = /\b(?:true[ ._-]?hd|mlp(?:fba)?)\b/.test(text)
  const hasEac3 = /\b(?:e[ ._-]?ac[ ._-]?3|eac3|ddp|dd\+)\b/.test(text)
  const hasAc3 = /\b(?:ac[ ._-]?3|ac3|dolby digital)\b/.test(text) && !hasEac3
  const hasDtsHd = /\b(?:dts[ ._-]?hd|dca[ ._-]?ma|dtsma)\b/.test(text)
  const hasDts = /\b(?:dts|dca)\b/.test(text) && !hasDtsHd && !hasDtsX
  const hasAac = /\baac\b/.test(text)
  const hasFlac = /\bflac\b/.test(text)

  return [
    {
      id: 'atmos', label: 'Dolby Atmos',
      state: hasAtmos ? 'detected' : (hasTrueHd || hasEac3) ? 'carrier' : 'not-detected',
      detail: hasAtmos ? (hasTrueHd ? 'TrueHD carrier' : hasEac3 ? 'Dolby Digital+ carrier' : 'metadata signaled') : (hasTrueHd || hasEac3) ? 'carrier active; Atmos metadata not signaled' : undefined,
    },
    { id: 'dtsx', label: 'DTS:X', state: hasDtsX ? 'detected' : hasDtsHd ? 'carrier' : 'not-detected', detail: hasDtsX ? 'object audio signaled' : hasDtsHd ? 'DTS-HD carrier active' : undefined },
    { id: 'truehd', label: 'Dolby TrueHD', state: hasTrueHd ? 'detected' : 'not-detected' },
    { id: 'eac3', label: 'Dolby Digital+', state: hasEac3 ? 'detected' : 'not-detected' },
    { id: 'ac3', label: 'Dolby Digital', state: hasAc3 ? 'detected' : 'not-detected' },
    { id: 'dtshd', label: 'DTS-HD', state: hasDtsHd ? 'detected' : 'not-detected' },
    { id: 'dts', label: 'DTS', state: hasDts ? 'detected' : 'not-detected' },
    { id: 'aac', label: 'AAC', state: hasAac ? 'detected' : 'not-detected' },
    { id: 'flac', label: 'FLAC', state: hasFlac ? 'detected' : 'not-detected' },
  ]
}

export function isEncodedAudioOutput(snapshot: NativePlayerDebugSnapshot): boolean {
  const text = JSON.stringify(snapshot.audioOutParams ?? '').toLowerCase()
  return /\b(?:spdif|iec61937|ac3|eac3|dts|truehd)\b/.test(text)
}
