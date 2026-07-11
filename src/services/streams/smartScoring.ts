import type { StreamResult, SubtitleResult } from '../../types'
import type { StreamReliabilityRecord } from './reliabilityHistory'
import { getReliability, streamFingerprint } from './reliabilityHistory'
import { getPlayableStreamUrl } from './playableUrl'

export type SmartPlayMode = 'best' | 'fastest' | 'highest-quality' | 'smallest-file'
export interface SmartStream extends StreamResult { addonId: string; addonName: string }
export interface SmartScoreContext {
  title: string
  season?: number
  episode?: number
  preferredAudio?: string[]
  preferredSubtitles?: string[]
  subtitles?: SubtitleResult[]
  mode: SmartPlayMode
  player: 'mpv' | 'web'
  maxSizeGb?: number
  history?: Record<string, StreamReliabilityRecord>
}
export interface ScoredStream { stream: SmartStream; score: number; reasons: string[] }

const text = (s: StreamResult) => [s.name, s.title, s.description, s.filename, s.behaviorHints?.filename].filter(Boolean).join(' ').toLowerCase()
export function parseSizeGb(value: string): number | undefined {
  const match = value.match(/\b(\d+(?:\.\d+)?)\s*(tb|gb|gib|mb|mib)\b/i)
  if (!match) return undefined
  const amount = Number(match[1]); const unit = match[2].toLowerCase()
  return unit === 'tb' ? amount * 1024 : unit.startsWith('m') ? amount / 1024 : amount
}
const resolution = (value: string) => /\b(4k|2160p|uhd)\b/i.test(value) ? 2160 : /\b1080p\b/i.test(value) ? 1080 : /\b720p\b/i.test(value) ? 720 : /\b(480p|sd)\b/i.test(value) ? 480 : 0
const normalized = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function scoreStream(stream: SmartStream, context: SmartScoreContext): ScoredStream {
  const value = text(stream); const reasons: string[] = []; let score = getPlayableStreamUrl(stream) ? 20 : -1000
  const res = resolution(value); const size = parseSizeGb(value)
  const qualityPoints = res === 2160 ? 30 : res === 1080 ? 24 : res === 720 ? 14 : res === 480 ? 5 : 8
  score += context.mode === 'highest-quality' ? qualityPoints * 2 : qualityPoints
  if (res) reasons.push(`${res}p quality`)
  if (context.mode === 'fastest') score += res <= 1080 && res >= 720 ? 18 : res === 2160 ? -12 : 4
  if (size != null) {
    score += context.mode === 'smallest-file' ? Math.max(-25, 30 - size * 3) : context.mode === 'highest-quality' ? Math.min(12, size / 3) : Math.max(-15, 8 - size)
    reasons.push(`${size.toFixed(size < 1 ? 1 : 0)} GB`)
    if (context.maxSizeGb && size > context.maxSizeGb) { score -= 45 + (size - context.maxSizeGb); reasons.push('over size preference') }
  }
  const incompatibleWeb = context.player === 'web' && /\b(hevc|h\.?265|x265|av1|truehd|dts)\b/i.test(value)
  score += incompatibleWeb ? -55 : 10; reasons.push(incompatibleWeb ? 'codec may be incompatible' : 'player compatible')
  const preferredAudio = context.preferredAudio || []
  const audioMatch = preferredAudio.find((lang) => new RegExp(`\\b${lang.replace(/[-_].*/, '')}\\b`, 'i').test(value))
  if (audioMatch) { score += 18; reasons.push(`preferred audio: ${audioMatch}`) }
  else if (preferredAudio.length && /\b(french|german|italian|spanish|rus|jpn|japanese|dub)\b/i.test(value)) { score -= 25; reasons.push('possible wrong language') }
  const allSubs = [...(stream.subtitles || []), ...(context.subtitles || [])]
  if ((context.preferredSubtitles || []).some((lang) => allSubs.some((sub) => sub.lang.toLowerCase().startsWith(lang.toLowerCase())))) { score += 8; reasons.push('preferred subtitles') }
  const expected = normalized(context.title).split(' ').filter((word) => word.length > 2)
  const overlap = expected.filter((word) => normalized(value).includes(word)).length / Math.max(1, expected.length)
  if (overlap >= .6) { score += 18; reasons.push('strong title match') } else if (expected.length && overlap === 0 && stream.filename) { score -= 35; reasons.push('weak title match') }
  if (context.season != null && context.episode != null) {
    const episodeMatch = new RegExp(`(?:s0?${context.season}e0?${context.episode}|${context.season}x0?${context.episode})`, 'i').test(value)
    if (episodeMatch) score += 24; else if (/\bs\d{1,2}e\d{1,3}\b/i.test(value)) { score -= 90; reasons.push('wrong episode') }
  }
  if (/\b(cam|camrip|hdcam|telesync|tsrip)\b/i.test(value)) { score -= 65; reasons.push('cam quality') }
  if (/\b(sample|trailer|teaser|featurette|fake)\b/i.test(value)) { score -= 120; reasons.push('sample/trailer/fake') }
  const history = getReliability(stream, context.history)
  const historyDelta = history.success * 9 + history.preferred * 14 - history.failedStart * 30 - history.unstable * 18 - history.reportedBad * 100
  score += Math.max(-240, Math.min(60, historyDelta))
  if (history.success) reasons.push(`${history.success} local success${history.success === 1 ? '' : 'es'}`)
  if (history.failedStart || history.unstable || history.reportedBad) reasons.push('local failure history')
  return { stream, score: Math.round(score * 10) / 10, reasons }
}

export function rankStreams(streams: SmartStream[], context: SmartScoreContext): ScoredStream[] {
  return streams.map((stream) => scoreStream(stream, context)).sort((a, b) => b.score - a.score || streamFingerprint(a.stream).localeCompare(streamFingerprint(b.stream)))
}

