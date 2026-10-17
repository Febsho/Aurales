import { invoke } from '@tauri-apps/api/core'

export interface SeekrPreviewCue {
  start: number
  end: number
  spriteUrl: string
  x: number
  y: number
  width: number
  height: number
}

export interface SeekrPreviewData {
  scale: number
  cues: SeekrPreviewCue[]
}

export interface SeekrPreviewRequest {
  duration: number
  tmdbId?: number
  imdbId?: string
  showTmdbId?: number
  season?: number
  episode?: number
}

/** The renderer only asks native Tauri for already-parsed Seekr metadata. */
export async function getSeekrPreview(request: SeekrPreviewRequest): Promise<SeekrPreviewData | null> {
  try {
    return await invoke<SeekrPreviewData | null>('get_seekr_preview', { request })
  } catch {
    return null
  }
}

/** Evict signed sprite metadata once playback really reaches EOF. */
export function clearSeekrPreview(request: SeekrPreviewRequest): void {
  void invoke('clear_seekr_preview', { request }).catch(() => {})
}

export function seekrCueAt(preview: SeekrPreviewData, playbackTime: number): SeekrPreviewCue | null {
  const sourceTime = playbackTime / (preview.scale || 1)
  return preview.cues.find((cue) => sourceTime >= cue.start && sourceTime < cue.end) || preview.cues.at(-1) || null
}
