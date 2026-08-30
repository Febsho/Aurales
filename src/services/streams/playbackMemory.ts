import type { StreamResult } from '../../types'
import { profileStorageKey } from '../profiles'
import { streamSearchText } from './streamFeatures'

export interface PlaybackPreference {
  addonId?: string
  addonFamily?: string
  sourceType?: string
  resolution?: string
  hdrFormat?: string
  videoCodec?: string
  audioCodec?: string
  releaseType?: string
  audioLanguage?: string
  subtitleLanguage?: string
  cached?: boolean
  successCount: number
  failureCount: number
  lastSuccessfulAt?: string
}
export type PlaybackMemory = Record<string, PlaybackPreference>
const KEY = 'aurales_stream_playback_memory_v1'

export function playbackMemoryKey(mediaType: 'movie' | 'series', mediaId: string, season?: number, episode?: number): string {
  const base = `${mediaType}:${mediaId}`
  return season != null && episode != null ? `${base}:s${season}:e${episode}` : base
}
export function seriesPlaybackMemoryKey(mediaId: string): string { return `series:${mediaId}` }
function addonFamily(addonId?: string) { return addonId?.replace(/https?:\/\//i, '').replace(/[?/#].*$/, '').replace(/[-_]?\d+$/i, '') }
const capture = (text: string, re: RegExp) => text.match(re)?.[1]?.toLowerCase()

/** Extracts durable release characteristics only; no URL, infohash, token, or private manifest data. */
export function playbackPreferenceFromStream(stream: StreamResult & { addonId?: string }, preferences: { audioLanguage?: string; subtitleLanguage?: string } = {}): PlaybackPreference {
  const text = streamSearchText(stream)
  return {
    addonId: stream.addonId, addonFamily: addonFamily(stream.addonId),
    sourceType: capture(text, /\b(usenet|torrent|direct|hls|web)\b/i),
    resolution: capture(text, /\b(2160p|4k|1080p|720p|480p)\b/i),
    hdrFormat: capture(text, /\b(dv|dovi|dolby vision|hdr10\+|hdr10|hdr)\b/i),
    videoCodec: capture(text, /\b(hevc|h\.265|x265|av1|h\.264|x264)\b/i),
    audioCodec: capture(text, /\b(truehd|atmos|ddp|eac3|dts|aac)\b/i),
    releaseType: capture(text, /\b(remux|blu-?ray|web[- ]?dl|web[- ]?rip)\b/i),
    audioLanguage: preferences.audioLanguage, subtitleLanguage: preferences.subtitleLanguage,
    cached: stream.behaviorHints?.torboxCached === true, successCount: 0, failureCount: 0,
  }
}
export function loadPlaybackMemory(profileId?: string): PlaybackMemory { try { return JSON.parse(localStorage.getItem(profileStorageKey(KEY, profileId)) || '{}') } catch { return {} } }
function save(memory: PlaybackMemory) { localStorage.setItem(profileStorageKey(KEY), JSON.stringify(memory)) }
export function recordPlaybackPreference(key: string, stream: StreamResult & { addonId?: string }, outcome: 'success' | 'failure', preferences?: { audioLanguage?: string; subtitleLanguage?: string }): void {
  const memory = loadPlaybackMemory(); const current = memory[key] || playbackPreferenceFromStream(stream, preferences)
  const fresh = playbackPreferenceFromStream(stream, preferences)
  memory[key] = { ...current, ...Object.fromEntries(Object.entries(fresh).filter(([, value]) => value !== undefined && value !== '')), successCount: current.successCount + (outcome === 'success' ? 1 : 0), failureCount: current.failureCount + (outcome === 'failure' ? 1 : 0), lastSuccessfulAt: outcome === 'success' ? new Date().toISOString() : current.lastSuccessfulAt }
  save(memory)
  // Only the derived characteristics are queued; stream URLs and provider
  // credentials never enter this record.
  void import('../sync/auralesSync').then(({ enqueueSyncRecord }) => enqueueSyncRecord('playback-memory', key, memory[key]))
}
export function resetPlaybackMemory(): void { localStorage.removeItem(profileStorageKey(KEY)) }
export function playbackMemoryScore(stream: StreamResult & { addonId?: string }, memories: Array<PlaybackPreference | undefined>): { score: number; reasons: string[] } {
  const current = playbackPreferenceFromStream(stream); let score = 0; const reasons: string[] = []
  for (const memory of memories.filter(Boolean) as PlaybackPreference[]) {
    const strength = Math.min(1, (memory.successCount + 1) / 3)
    const add = (same: boolean, points: number, label: string) => { if (same) { const value = Math.round(points * strength); score += value; reasons.push(`playback memory: +${value} ${label}`) } }
    add(Boolean(memory.addonId && memory.addonId === current.addonId), 12, 'same successful addon')
    add(Boolean(memory.addonFamily && memory.addonFamily === current.addonFamily), 6, 'same addon family')
    add(Boolean(memory.sourceType && memory.sourceType === current.sourceType), 8, 'same source type')
    add(Boolean(memory.resolution && memory.resolution === current.resolution), 6, 'preferred resolution')
    add(Boolean(memory.hdrFormat && memory.hdrFormat === current.hdrFormat), 5, 'preferred HDR')
    add(Boolean(memory.releaseType && memory.releaseType === current.releaseType), 5, 'same release type')
    add(Boolean(memory.audioLanguage && memory.audioLanguage === current.audioLanguage), 4, 'preferred audio')
    if (memory.failureCount > memory.successCount && memory.addonId === current.addonId) { score -= 10; reasons.push('playback memory: -10 previous failure pattern') }
  }
  return { score: Math.max(-25, Math.min(45, score)), reasons }
}
