import type { StreamResult } from '../../types'

/**
 * Tech-spec badges shown on detail pages (Apple TV style): resolution, HDR
 * format, audio and accessibility. Deliberately no source tier or video codec
 * — those describe the file, not the viewing experience. Derived from the top
 * stream's release name, since addons rarely expose structured media info.
 */
export type StreamFeatureGroup = 'resolution' | 'visual' | 'audio' | 'access'

export interface StreamFeature {
  id: string
  label: string
  group: StreamFeatureGroup
  /** Second line of a two-line lockup, e.g. Dolby / VISION. */
  sublabel?: string
  /** Brand glyph rendered before the label. */
  mark?: 'dolby'
}

interface FeatureRule extends StreamFeature {
  token: RegExp
}

// Ordered within each group by specificity: the first match per group wins, so
// HDR10+ beats HDR10 and TrueHD beats the plain DTS fallback.
const RESOLUTION_RULES: FeatureRule[] = [
  { id: '8k', label: '8K', group: 'resolution', token: /\b(8k|4320p)\b/i },
  { id: '4k', label: '4K', group: 'resolution', token: /\b(4k|2160p|uhd)\b/i },
  { id: '1440p', label: '1440p', group: 'resolution', token: /\b(1440p|2k)\b/i },
  { id: '1080p', label: 'HD', group: 'resolution', token: /\b(1080p|fhd)\b/i },
  { id: '720p', label: 'HD', group: 'resolution', token: /\b720p\b/i },
  { id: '480p', label: 'SD', group: 'resolution', token: /\b(480p|576p|sd)\b/i },
]

const DOLBY_VISION_RULE: FeatureRule = {
  id: 'dv', label: 'Dolby', sublabel: 'Vision', mark: 'dolby', group: 'visual',
  token: /\b(dv|dovi)\b|dolby\s?vision/i,
}

const HDR_RULES: FeatureRule[] = [
  { id: 'hdr10plus', label: 'HDR10+', group: 'visual', token: /\bhdr10\+|\bhdr10plus\b/i },
  { id: 'hdr10', label: 'HDR10', group: 'visual', token: /\bhdr10\b/i },
  { id: 'hlg', label: 'HLG', group: 'visual', token: /\bhlg\b/i },
  { id: 'hdr', label: 'HDR', group: 'visual', token: /\bhdr\b/i },
]

const IMAX_RULE: FeatureRule = { id: 'imax', label: 'IMAX', group: 'visual', token: /\bimax\b/i }

// Object-based formats ride on top of a base codec, so they are detected
// separately and both are shown — the same way the stream picker lists them.
const IMMERSIVE_AUDIO_RULES: FeatureRule[] = [
  { id: 'atmos', label: 'Dolby', sublabel: 'Atmos', mark: 'dolby', group: 'audio', token: /\batmos\b/i },
  { id: 'dtsx', label: 'DTS:X', group: 'audio', token: /\bdts[\s-]?x\b/i },
]

const AUDIO_CODEC_RULES: FeatureRule[] = [
  { id: 'truehd', label: 'TrueHD', group: 'audio', token: /\btrue[\s-]?hd\b/i },
  { id: 'dtshd', label: 'DTS-HD', group: 'audio', token: /\bdts[\s-]?hd(?:[\s-]?ma)?\b/i },
  { id: 'flac', label: 'FLAC', group: 'audio', token: /\bflac\b/i },
  // Channel counts are glued straight onto the codec in the wild ("DDP5.1"),
  // so every codec token has to tolerate a trailing digit.
  { id: 'ddp', label: 'Dolby', sublabel: 'Digital+', mark: 'dolby', group: 'audio', token: /\b(ddp\d?|dd\+|eac3|e[\s-]?ac[\s-]?3)\b/i },
  { id: 'dts', label: 'DTS', group: 'audio', token: /\bdts\d?\b/i },
  { id: 'dd', label: 'Dolby', sublabel: 'Digital', mark: 'dolby', group: 'audio', token: /\b(dd\d?|ac3|ac[\s-]?3)\b/i },
  { id: 'aac', label: 'AAC', group: 'audio', token: /\baac\b/i },
]

// Not \b-anchored on the left: "DDP5.1" puts a word character right before the
// channel count, which a word boundary would reject.
const CHANNEL_RULES: FeatureRule[] = [
  // The trailing guard keeps a "5.1 GB" file size from reading as a channel layout.
  { id: '71', label: '7.1', group: 'audio', token: /(?:^|[^\d.])7\.1(?!\d|\s*[gmt]b\b)/i },
  { id: '51', label: '5.1', group: 'audio', token: /(?:^|[^\d.])5\.1(?!\d|\s*[gmt]b\b)/i },
  { id: '20', label: 'Stereo', group: 'audio', token: /(?:^|[^\d.])(2\.0(?!\d)|stereo\b)/i },
]

/** Everything an addon might have written the release name into. */
export function streamSearchText(stream: StreamResult): string {
  return [stream.name, stream.title, stream.description, stream.filename]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    // Release names use dots/underscores as separators; \b alone won't split
    // "Dolby.Vision" the way the tokens expect. Keep separators that sit
    // between digits, or "5.1" would decay into an unmatchable "5 1".
    .replace(/[._]/g, (separator, offset: number, full: string) =>
      /\d/.test(full[offset - 1] ?? '') && /\d/.test(full[offset + 1] ?? '') ? separator : ' ')
}

function toFeature(rule: FeatureRule): StreamFeature {
  return { id: rule.id, label: rule.label, group: rule.group, sublabel: rule.sublabel, mark: rule.mark }
}

function firstMatch(rules: FeatureRule[], text: string): StreamFeature | null {
  const rule = rules.find((candidate) => candidate.token.test(text))
  return rule ? toFeature(rule) : null
}

/**
 * Badge list for a single stream, ordered the way the hero renders them:
 * resolution → HDR → audio → accessibility, with the two Dolby lockups
 * (Vision, Atmos) kept adjacent so the brand reads as one pair instead of
 * bookending an unrelated HDR10+ badge in between.
 */
export function detectStreamFeatures(stream: StreamResult | null | undefined): StreamFeature[] {
  if (!stream) return []
  const text = streamSearchText(stream)
  if (!text.trim()) return []

  const features: StreamFeature[] = []
  const push = (feature: StreamFeature | null) => { if (feature) features.push(feature) }

  push(firstMatch(RESOLUTION_RULES, text))
  if (IMAX_RULE.token.test(text)) push(toFeature(IMAX_RULE))

  // A Dolby Vision release usually carries an HDR10 base layer, and releases
  // label both. Show both, but hold Dolby Vision back — it moves next to
  // Atmos below — so the non-Dolby HDR badge doesn't sit between them.
  const dolbyVision = DOLBY_VISION_RULE.token.test(text)
  const hdr = firstMatch(HDR_RULES, text)
  if (hdr && !(dolbyVision && hdr.id === 'hdr')) push(hdr)

  if (dolbyVision) push(toFeature(DOLBY_VISION_RULE))
  const immersive = firstMatch(IMMERSIVE_AUDIO_RULES, text)
  push(immersive)
  const audioCodec = firstMatch(AUDIO_CODEC_RULES, text)
  // Atmos is carried inside TrueHD/DD+; naming both is informative, but don't
  // repeat the same Dolby lockup twice in a row.
  if (audioCodec && !(immersive && audioCodec.mark === 'dolby')) push(audioCodec)
  push(firstMatch(CHANNEL_RULES, text))

  const subtitleCount = stream.subtitles?.length ?? 0
  if (subtitleCount > 0) push({ id: 'cc', label: 'CC', group: 'access' })
  if (/\bsdh\b/i.test(text)) push({ id: 'sdh', label: 'SDH', group: 'access' })

  return features
}
