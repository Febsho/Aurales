export type SubtitleStartupMode = 'show' | 'forced' | 'hide'

export interface LanguageTrack {
  lang?: string
  label?: string
  forced?: boolean
}

type LanguageNormalizer = (language?: string) => string | null

function isSdhTrack(track: LanguageTrack): boolean {
  return /\b(?:sdh|cc|closed[ -]?captions?)\b/i.test(track.label || '')
}

function isForcedTrack(track: LanguageTrack): boolean {
  return Boolean(track.forced || /\bforced\b/i.test(track.label || ''))
}

export function audioLanguageOrder(preferred: string[], isAnime: boolean, animeMode: 'sub' | 'dub'): string[] {
  return isAnime && animeMode === 'sub'
    ? ['ja', ...preferred.filter((language) => language !== 'ja')]
    : preferred
}

export function selectPreferredLanguageTrack<T extends LanguageTrack>(
  tracks: T[],
  preferred: string[],
  normalize: LanguageNormalizer,
): T | undefined {
  let best: T | undefined
  let bestRank = Infinity
  for (const track of tracks) {
    const code = normalize(track.lang)
    const rank = code ? preferred.indexOf(code) : -1
    if (rank >= 0 && rank < bestRank) {
      best = track
      bestRank = rank
    }
  }
  return best
}

export type SubtitleStartupSelection<T> =
  | { kind: 'track'; track: T }
  | { kind: 'off' }
  | { kind: 'unchanged' }

/** Select subtitles by language first. The matching-audio mode only applies
 * when the chosen audio and best available subtitle actually share a language.
 */
export function selectStartupSubtitle<T extends LanguageTrack>(options: {
  tracks: T[]
  preferred: string[]
  preferSdh: boolean
  mode: SubtitleStartupMode
  selectedAudioLanguage?: string
  normalize: LanguageNormalizer
}): SubtitleStartupSelection<T> {
  const { tracks, preferred, preferSdh, mode, selectedAudioLanguage, normalize } = options
  const ranked = [...tracks].sort((left, right) => {
    const leftCode = normalize(left.lang)
    const rightCode = normalize(right.lang)
    const leftLanguageRank = leftCode ? preferred.indexOf(leftCode) : -1
    const rightLanguageRank = rightCode ? preferred.indexOf(rightCode) : -1
    const normalizedLeftRank = leftLanguageRank < 0 ? Infinity : leftLanguageRank
    const normalizedRightRank = rightLanguageRank < 0 ? Infinity : rightLanguageRank
    if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank
    const leftForcedPenalty = isForcedTrack(left) ? 1 : 0
    const rightForcedPenalty = isForcedTrack(right) ? 1 : 0
    if (leftForcedPenalty !== rightForcedPenalty) return leftForcedPenalty - rightForcedPenalty
    const leftSdhPenalty = isSdhTrack(left) === preferSdh ? 0 : 1
    const rightSdhPenalty = isSdhTrack(right) === preferSdh ? 0 : 1
    return leftSdhPenalty - rightSdhPenalty
  })
  const best = ranked.find((track) => {
    const code = normalize(track.lang)
    return Boolean(code && preferred.includes(code))
  })
  if (!best) return { kind: 'unchanged' }

  const audioCode = normalize(selectedAudioLanguage)
  const subtitleCode = normalize(best.lang)
  if (!audioCode || audioCode !== subtitleCode || mode === 'show') return { kind: 'track', track: best }
  if (mode === 'hide') return { kind: 'off' }

  const forced = ranked.find((track) => normalize(track.lang) === audioCode && isForcedTrack(track))
  return forced ? { kind: 'track', track: forced } : { kind: 'off' }
}
