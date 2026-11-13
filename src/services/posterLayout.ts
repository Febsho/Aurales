export interface PosterDetailOptions {
  genre: boolean
  rating: boolean
  ageRating: boolean
}

export type PosterFadeLength = 'short' | 'standard' | 'tall'
export type PosterColorMode = 'artwork' | 'dark' | 'neutral'
export const POSTER_EPISODE_SEGMENT_LIMIT = 10

/** Read only quality facts present on the item; never guess from a title or image. */
export function getPosterTechnicalBadges(raw?: Record<string, unknown>): string[] {
  if (!raw) return []
  const streams: Record<string, unknown>[] = []
  const appendStreams = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (entry && typeof entry === 'object') streams.push(entry as Record<string, unknown>)
    }
  }
  appendStreams(raw.MediaStreams)
  if (Array.isArray(raw.MediaSources)) {
    for (const source of raw.MediaSources) {
      if (source && typeof source === 'object') appendStreams((source as Record<string, unknown>).MediaStreams)
    }
  }

  const videos = streams.filter((stream) => String(stream.Type || '').toLowerCase() === 'video')
  if (!videos.length) return []
  const dimension = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  const pixels = (stream: Record<string, unknown>) => Math.max(dimension(stream.Width), dimension(stream.Height))
  const bestVideo = videos.reduce((best, stream) => pixels(stream) > pixels(best) ? stream : best)
  const maxDimension = pixels(bestVideo)
  const resolution = maxDimension >= 3_800 ? '4K' : maxDimension >= 1_900 ? '1080p' : maxDimension >= 1_200 ? '720p' : undefined
  const range = videos.map((stream) => `${stream.VideoRangeType || ''} ${stream.VideoRange || ''}`.toUpperCase()).join(' ')
  const hdr = /DOLBY[ _-]?VISION|DOVI/.test(range) ? 'Dolby Vision'
    : /HDR10\s*\+|HDR10PLUS/.test(range) ? 'HDR10+'
      : /HDR10/.test(range) ? 'HDR10'
        : /HLG/.test(range) ? 'HLG'
          : /HDR/.test(range) ? 'HDR' : undefined
  return [hdr, resolution].filter((badge): badge is string => Boolean(badge))
}

export function getPosterEpisodeSegmentCount(total?: number): number {
  return total != null && total > 0 ? Math.min(Math.floor(total), POSTER_EPISODE_SEGMENT_LIMIT) : 0
}

export function getPosterArtworkCandidate(
  artwork: 'poster' | 'backdrop',
  poster?: string,
  cleanPoster?: string,
  backdrop?: string,
): string | undefined {
  if (artwork === 'backdrop') return backdrop || cleanPoster || poster
  // The poster and title logo are separate layers in Aurales. Prefer the
  // clean alternate even when the primary poster came from Jellyfin or an
  // attached service; otherwise provider-baked title artwork sits underneath
  // the app logo and ratings. Keep the chosen poster as the fallback, then a
  // scene image only when the catalog has no poster at all.
  return cleanPoster || poster || backdrop
}

export const POSTER_RATING_CAPTION_CLASS = 'mt-1 flex min-h-4 items-center gap-1 text-[11px] font-semibold leading-none tabular-nums text-white'
export const POSTER_RATING_CAPTION_STAR_CLASS = 'h-3 w-3 shrink-0 fill-current text-white'

/** Keep the fade in live cards and settings previews pixel-for-pixel aligned. */
export function getPosterFadeAppearance(
  fade: PosterFadeLength,
  colorMode: PosterColorMode,
  ambientColor?: { r: number; g: number; b: number } | null,
): { heightClass: string; height: string; colorClass: string; background: string; style?: { background: string } } {
  // Odin's fade keeps the image visible behind captions while carrying a
  // clearly visible tint from the artwork into the bottom edge. The black
  // gradient remains underneath so white captions stay legible on mobile.
  const neutralFade = 'linear-gradient(to top, rgba(12,13,16,.76) 0%, rgba(12,13,16,.52) 14%, rgba(12,13,16,.26) 38%, rgba(12,13,16,.08) 70%, transparent 100%)'
  const tint = ambientColor
    ? `${ambientColor.r},${ambientColor.g},${ambientColor.b}`
    : undefined
  const style = colorMode === 'artwork' && tint
    ? { background: `linear-gradient(to top, rgba(${tint},.48) 0%, rgba(${tint},.35) 14%, rgba(${tint},.17) 38%, rgba(${tint},.04) 70%, transparent 100%), linear-gradient(to top, rgba(0,0,0,.58) 0%, rgba(0,0,0,.42) 14%, rgba(0,0,0,.22) 38%, rgba(0,0,0,.07) 70%, transparent 100%)` }
    : undefined
  const blackFade = 'linear-gradient(to top, rgba(0,0,0,.58) 0%, rgba(0,0,0,.42) 14%, rgba(0,0,0,.22) 38%, rgba(0,0,0,.07) 70%, transparent 100%)'
  const background = style?.background ?? (colorMode === 'neutral' ? neutralFade : blackFade)
  return {
    heightClass: fade === 'short' ? 'h-[28%]' : fade === 'tall' ? 'h-[44%]' : 'h-[36%]',
    height: fade === 'short' ? '28%' : fade === 'tall' ? '44%' : '36%',
    background,
    colorClass: colorMode === 'neutral'
      ? 'bg-[linear-gradient(to_top,rgba(12,13,16,.76)_0%,rgba(12,13,16,.52)_14%,rgba(12,13,16,.26)_38%,rgba(12,13,16,.08)_70%,transparent_100%)]'
      : 'bg-[linear-gradient(to_top,rgba(0,0,0,.76)_0%,rgba(0,0,0,.52)_14%,rgba(0,0,0,.26)_38%,rgba(0,0,0,.08)_70%,transparent_100%)]',
    ...(style ? { style } : {}),
  }
}

/** Odin displays at most two of these detail fields on any poster. */
export function getPosterVisibleDetails({ genre, rating, ageRating }: PosterDetailOptions): PosterDetailOptions {
  let remaining = 2
  const visible: PosterDetailOptions = { genre: false, rating: false, ageRating: false }
  for (const field of ['genre', 'rating', 'ageRating'] as const) {
    if (remaining > 0 && ({ genre, rating, ageRating })[field]) {
      visible[field] = true
      remaining -= 1
    }
  }
  return visible
}

