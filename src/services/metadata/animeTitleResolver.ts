import type { AnimeTitleInput, AnimeTitlePreference, AnimeSeasonTitleInput } from './types'

export function isLikelyJapaneseOnly(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-龯]/.test(text)
}

export function resolveAnimeDisplayTitle(
  input: AnimeTitleInput,
  preference: AnimeTitlePreference = 'auto',
): string {
  if (preference === 'english') {
    return input.english ?? input.localized ?? input.romaji ?? input.native ?? input.providerTitle ?? 'Unknown'
  }
  if (preference === 'localized') {
    return input.localized ?? input.english ?? input.romaji ?? input.native ?? input.providerTitle ?? 'Unknown'
  }
  if (preference === 'romaji') {
    return input.romaji ?? input.english ?? input.localized ?? input.native ?? input.providerTitle ?? 'Unknown'
  }
  if (preference === 'native') {
    return input.native ?? input.english ?? input.localized ?? input.romaji ?? input.providerTitle ?? 'Unknown'
  }
  // auto
  return input.english ?? input.localized ?? input.romaji ?? input.native ?? input.providerTitle ?? 'Unknown'
}

export function resolveAnimeSeasonTitle(
  input: AnimeSeasonTitleInput,
  preference: AnimeTitlePreference = 'auto',
  useGenericLabels = true,
  avoidJapanese = true,
): string {
  if (input.seasonNumber === 0) return 'Specials'

  if (!useGenericLabels) {
    const preferred = preference === 'native'
      ? input.native ?? input.english ?? input.localized ?? input.romaji
      : input.english ?? input.localized ?? input.romaji

    if (preferred) {
      if (avoidJapanese && isLikelyJapaneseOnly(preferred)) {
        return `Season ${input.seasonNumber}`
      }
      return preferred
    }
  }

  if (!useGenericLabels) {
    const provTitle = input.providerTitle
    if (provTitle && (!avoidJapanese || !isLikelyJapaneseOnly(provTitle))) {
      return provTitle
    }
  }

  // With generic labels enabled, or no good title found
  if (useGenericLabels) {
    const englishTitle = input.english ?? input.localized ?? input.romaji
    if (englishTitle && !isLikelyJapaneseOnly(englishTitle)) {
      const generic = `Season ${input.seasonNumber}`
      if (englishTitle === generic || englishTitle === `Season ${input.seasonNumber}`) {
        return generic
      }
      return `Season ${input.seasonNumber}: ${englishTitle}`
    }
  }

  return `Season ${input.seasonNumber}`
}

export function resolveSeasonTitles(
  title: string | undefined,
  seasonNumber: number,
  preference: AnimeTitlePreference = 'auto',
  useGenericLabels = true,
  avoidJapanese = true,
): { displayTitle: string; originalTitle?: string; nativeTitle?: string } {
  if (seasonNumber === 0) return { displayTitle: 'Specials' }

  if (!title) return { displayTitle: `Season ${seasonNumber}` }

  const japanese = isLikelyJapaneseOnly(title)

  if (japanese && avoidJapanese) {
    return {
      displayTitle: `Season ${seasonNumber}`,
      nativeTitle: title,
      originalTitle: title,
    }
  }

  if (useGenericLabels && !japanese) {
    return { displayTitle: `Season ${seasonNumber}` }
  }

  if (preference === 'native' || !avoidJapanese) {
    return { displayTitle: title }
  }

  return { displayTitle: `Season ${seasonNumber}`, originalTitle: title }
}
