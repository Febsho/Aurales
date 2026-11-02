import type { SearchResult } from '../../types'
import type { DiscoveryActivity, DiscoveryMode, DiscoverySection, RankedRecommendation, RecommendationCandidate, RecommendationFeedback, RecommendationReason, RecommendationScore, TasteProfile, TasteSignal } from './types'

export const RECOMMENDATION_WEIGHTS = {
  completed: 3.5,
  recent: 2.2,
  inProgress: 1.2,
  abandoned: -2.4,
  genreAffinity: 9,
  quality: 2.5,
  novelty: 4,
  exploration: 2,
  watchedPenalty: -35,
  explicitNegative: -100,
  explicitPositive: 18,
} as const

const POPULARITY_REFERENCE = 250

function popularitySignal(value: number | undefined): number {
  return Math.max(0, Math.min(1,
    Math.log1p(Math.max(0, value || 0)) / Math.log1p(POPULARITY_REFERENCE),
  ))
}

const GENRES: Record<number, string> = { 28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',10752:'War',37:'Western',10759:'Action & Adventure',10762:'Kids',10763:'News',10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics' }

const KEYWORD_STOPWORDS = new Set((
  'about above after again against all also am an and any are as at back be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves ' +
  'aber als am an auch auf aus bei bin bis bist das dass dem den der des die doch durch ein eine einem einen einer eines er es für gegen gewesen hat hatte haben hier ich im in ist jede jeder jedes mit muss nach nicht noch nun oder sein seine sich sie sind so über um und uns unser unter vom von vor war waren was weg weil weiter welche wenn werde werden wie wieder wir wo zu zum zur'
).split(/\s+/))

function extractKeywords(text: string | undefined): Set<string> {
  if (!text) return new Set()
  const normalized = text.slice(0, 1400).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
  const tokens = normalized.match(/[\p{L}\p{N}]{4,}/gu) || []
  return new Set(tokens.filter((token) => !KEYWORD_STOPWORDS.has(token)))
}

export function mediaKey(item: Pick<SearchResult, 'id' | 'type' | 'tmdbId' | 'imdbId'>): string {
  const tmdbId = normalizedTmdbId(item.tmdbId)
  if (tmdbId) return `${item.type}:tmdb:${tmdbId}`
  const imdbId = normalizedImdbId(item.imdbId)
  if (imdbId) return `${item.type}:imdb:${imdbId}`
  return `${item.type}:local:${item.id}`
}

function normalizedTmdbId(value: string | number | null | undefined): string {
  return value == null ? '' : String(value).trim().replace(/^tmdb[-:]/i, '')
}

function normalizedImdbId(value: string | undefined): string {
  return value?.trim().replace(/^imdb[-:]/i, '').toLowerCase() || ''
}

function feedbackMediaKey(feedback: RecommendationFeedback): string {
  // Recompute from the stored item so feedback saved before ID normalization
  // continues to apply after an app update.
  return mediaKey(feedback.item)
}

export function buildTasteProfile(activity: DiscoveryActivity, now = Date.now()): TasteProfile {
  const genreWeights: Record<number, number> = {}
  const decadeWeights: Record<string, number> = {}, languageWeights:Record<string,number>={}, countryWeights:Record<string,number>={}, personWeights:Record<string,number>={}, keywordWeights:Record<string,number>={}
  let movieWeight = 0, seriesWeight = 0, animeWeight = 0
  let runtimeWeight = 0, runtimeTotal = 0
  const metadata = new Map<string, NonNullable<DiscoveryActivity['tasteMetadata']>[number]>()
  activity.tasteMetadata?.forEach((entry) => {
    metadata.set(mediaKey(entry.item), entry)
    metadata.set(entry.item.id, entry)
    if (entry.item.tmdbId != null) metadata.set(String(entry.item.tmdbId), entry)
    if (entry.item.imdbId) metadata.set(entry.item.imdbId, entry)
  })
  const metadataFor = (item: SearchResult) => metadata.get(mediaKey(item)) || metadata.get(item.id) || (item.tmdbId != null ? metadata.get(String(item.tmdbId)) : undefined) || (item.imdbId ? metadata.get(item.imdbId) : undefined)
  const add = (item: SearchResult, weight: number) => {
    const detail = metadataFor(item)
    const keywords = extractKeywords(`${item.title} ${item.overview || ''}`)
    const keywordWeight = keywords.size ? weight / Math.sqrt(keywords.size) : 0
    keywords.forEach((keyword) => { keywordWeights[keyword] = (keywordWeights[keyword] || 0) + keywordWeight })
    item.genreIds?.forEach((id) => { genreWeights[id] = (genreWeights[id] || 0) + weight })
    if (item.year) { const decade = `${Math.floor(item.year / 10) * 10}s`; decadeWeights[decade] = (decadeWeights[decade] || 0) + weight }
    if(item.originalLanguage)languageWeights[item.originalLanguage]=(languageWeights[item.originalLanguage]||0)+weight
    item.originCountry?.forEach((country)=>{countryWeights[country]=(countryWeights[country]||0)+weight})
    if (item.type === 'movie') movieWeight += weight
    else seriesWeight += weight
    if (item.isAnime) animeWeight += weight
    // Only positive choices establish a duration preference. A short
    // abandoned title should not turn into a preference for short titles.
    if (weight > 0 && detail?.runtimeMinutes && detail.runtimeMinutes > 0) {
      runtimeTotal += detail.runtimeMinutes * weight
      runtimeWeight += weight
    }
    ;[...(detail?.cast || []), ...(detail?.directors || [])].forEach((person) => {
      const name = person.trim()
      if (name) personWeights[name] = (personWeights[name] || 0) + weight
    })
  }
  activity.recent.forEach((item, index) => add(item, RECOMMENDATION_WEIGHTS.recent * Math.exp(-index / 12)))
  activity.ratings?.forEach(({item,rating}) => add(item, rating >= 8 ? 5 : rating >= 6 ? 1.5 : rating <= 4 ? -4 : 0))
  activity.completedItems?.forEach((item) => add(item, RECOMMENDATION_WEIGHTS.completed))
  activity.abandonedItems?.forEach((item) => add(item, RECOMMENDATION_WEIGHTS.abandoned))
  activity.watchlist?.forEach((item)=>add(item,1.8))
  activity.rewatches?.forEach((item)=>add(item,7))
  activity.bingeItems?.forEach((item)=>add(item,4))
  // Partial playback is an active session until the caller has evidence that
  // it was abandoned. Completion and abandonment are title-level signals.
  const completedSignalKeys = new Set((activity.completedItems || []).map(mediaKey))
  const recentById = new Map<string, { item: SearchResult; index: number }>()
  const recentByTmdbId = new Map<string, { item: SearchResult; index: number }>()
  const recentByImdbId = new Map<string, { item: SearchResult; index: number }>()
  activity.recent.forEach((item, index) => {
    // Keep the first occurrence, matching Array.find()'s existing behavior.
    if (!recentById.has(item.id)) recentById.set(item.id, { item, index })
    const tmdbId = normalizedTmdbId(item.tmdbId)
    const imdbId = normalizedImdbId(item.imdbId)
    if (tmdbId && !recentByTmdbId.has(tmdbId)) recentByTmdbId.set(tmdbId, { item, index })
    if (imdbId && !recentByImdbId.has(imdbId)) recentByImdbId.set(imdbId, { item, index })
  })
  activity.progress.filter((progress) => progress.completed).forEach((progress) => {
    const tmdbId = normalizedTmdbId(progress.tmdbId)
    const imdbId = normalizedImdbId(progress.imdbId)
    const matches = [
      recentById.get(progress.mediaId),
      tmdbId ? recentByTmdbId.get(tmdbId) : undefined,
      imdbId ? recentByImdbId.get(imdbId) : undefined,
    ].filter((match): match is { item: SearchResult; index: number } => match != null)
    const item = matches.reduce((first, match) => match.index < first.index ? match : first, matches[0]!)?.item
    if (!item) return
    const key = mediaKey(item)
    if (completedSignalKeys.has(key)) return
    completedSignalKeys.add(key)
    add(item, RECOMMENDATION_WEIGHTS.completed)
  })
  const activityCount = activity.recent.length + activity.progress.length + (activity.completedItems?.length || 0) + (activity.abandonedItems?.length || 0)
  const signals:TasteSignal[] = Object.entries(genreWeights).sort((a,b) => b[1]-a[1]).slice(0, 6).map(([id, weight]) => ({ kind: 'genre' as const, value: GENRES[Number(id)] || `Genre ${id}`, weight, evidenceCount: Math.max(1, Math.round(Math.abs(weight) / 2)) }))
  Object.entries(decadeWeights).sort((a,b)=>b[1]-a[1]).slice(0,1).forEach(([value,weight])=>signals.push({kind:'decade',value,weight,evidenceCount:Math.max(1,Math.round(Math.abs(weight)/2))}))
  if(animeWeight>2)signals.push({kind:'anime',value:'Anime',weight:animeWeight,evidenceCount:Math.max(1,Math.round(animeWeight/2))})
  const preferredFormat:[string,number]=movieWeight>seriesWeight?['Movies',movieWeight]:['Series',seriesWeight]
  if(Number(preferredFormat[1])>2)signals.push({kind:'format',value:String(preferredFormat[0]),weight:Number(preferredFormat[1]),evidenceCount:Math.max(1,Math.round(Number(preferredFormat[1])/2))})
  Object.entries(personWeights).sort((a,b)=>b[1]-a[1]).slice(0,3).forEach(([value, weight]) => signals.push({kind:'person',value,weight,evidenceCount:Math.max(1,Math.round(Math.abs(weight)/2))}))
  const preferredRuntimeMinutes = runtimeWeight ? Math.round(runtimeTotal / runtimeWeight) : undefined
  if (preferredRuntimeMinutes) signals.push({kind:'runtime',value:`Around ${preferredRuntimeMinutes} min`,weight:runtimeWeight,evidenceCount:Math.max(1,Math.round(runtimeWeight/2))})
  return { signals, genreWeights, decadeWeights, languageWeights, countryWeights, personWeights, keywordWeights, preferredRuntimeMinutes, movieWeight, seriesWeight, animeWeight, activityCount, confidence: activityCount < 3 ? 'low' : activityCount < 12 ? 'medium' : 'high', generatedAt: now }
}

function watchedKeys(activity: DiscoveryActivity): Set<string> {
  const keys = new Set<string>()
  activity.progress.filter((p) => p.completed).forEach((p) => {
    keys.add(String(p.mediaId).trim())
    const tmdbId = normalizedTmdbId(p.tmdbId)
    const imdbId = normalizedImdbId(p.imdbId)
    if (tmdbId) keys.add(tmdbId)
    if (imdbId) keys.add(imdbId)
  })
  return keys
}

export function dedupeCandidates(candidates: RecommendationCandidate[]): RecommendationCandidate[] {
  const merged = new Map<string,RecommendationCandidate>()
  for(const candidate of candidates){const key=mediaKey(candidate.item);const existing=merged.get(key);if(!existing){merged.set(key,candidate);continue}const informativeSource=candidate.source==='tmdb-similar'||candidate.source==='tmdb-cast'||candidate.source==='tmdb-director';const favoriteSeed=existing.seedKind==='favorited'?existing:candidate.seedKind==='favorited'?candidate:undefined;merged.set(key,{...existing,source:informativeSource?candidate.source:existing.source,item:{...candidate.item,...existing.item,genreIds:existing.item.genreIds||candidate.item.genreIds,genres:existing.item.genres||candidate.item.genres},runtimeMinutes:existing.runtimeMinutes??candidate.runtimeMinutes,voteCount:Math.max(existing.voteCount||0,candidate.voteCount||0)||undefined,popularity:Math.max(existing.popularity||0,candidate.popularity||0)||undefined,trendSignal:Boolean(existing.trendSignal||candidate.trendSignal||existing.source==='tmdb-trending'||candidate.source==='tmdb-trending'),releaseDate:existing.releaseDate??candidate.releaseDate,seedTitle:favoriteSeed?.seedTitle??existing.seedTitle??candidate.seedTitle,seedKind:favoriteSeed?.seedKind??existing.seedKind??candidate.seedKind})}
  return [...merged.values()]
}

export interface RankingWeightOverrides {
  genre?: number
  keyword?: number
  people?: number
  quality?: number
  popularity?: number
  novelty?: number
  recency?: number
  era?: number
  language?: number
}

const RECENT_RELEASE_WINDOW_MS = 365.25 * 24 * 60 * 60 * 1000

function releaseDateTimestamp(item: SearchResult): number | undefined {
  const date = item.releaseDate?.slice(0, 10)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const timestamp = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp)) return undefined
  const parsed = new Date(timestamp)
  const [year, month, day] = date.split('-').map(Number)
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day ? timestamp : undefined
}

function isRecentlyReleased(item: SearchResult, now: number): boolean {
  const timestamp = releaseDateTimestamp(item)
  if (timestamp != null) return timestamp <= now && timestamp >= now - RECENT_RELEASE_WINDOW_MS
  // Some addon and cached results only carry a year. Treat current-year titles
  // as recent; a previous calendar year alone is too imprecise to call recent.
  return item.year === new Date(now).getUTCFullYear()
}

function compareReleaseRecency(left: SearchResult, right: SearchResult): number {
  const leftTimestamp = releaseDateTimestamp(left)
  const rightTimestamp = releaseDateTimestamp(right)
  const leftYear = left.year ?? (leftTimestamp == null ? 0 : new Date(leftTimestamp).getUTCFullYear())
  const rightYear = right.year ?? (rightTimestamp == null ? 0 : new Date(rightTimestamp).getUTCFullYear())
  if (leftYear !== rightYear) return rightYear - leftYear
  if (leftTimestamp != null && rightTimestamp != null) return rightTimestamp - leftTimestamp
  return 0
}

function recommendationReleaseYear(item: SearchResult, now: number): number | undefined {
  const timestamp = releaseDateTimestamp(item)
  return timestamp == null ? item.year : new Date(timestamp).getUTCFullYear()
}

export function rankCandidates(candidates: RecommendationCandidate[], profile: TasteProfile, activity: DiscoveryActivity, feedback: RecommendationFeedback[], mode: DiscoveryMode, now = Date.now(), impressions: Record<string,number> = {}, weights: RankingWeightOverrides = {}): RankedRecommendation[] {
  const uniqueCandidates = dedupeCandidates(candidates)
  const completed = watchedKeys(activity)
  const rewatchKeys=new Set((activity.rewatches||[]).flatMap((item)=>[item.id,normalizedTmdbId(item.tmdbId),normalizedImdbId(item.imdbId)]).filter(Boolean))
  const feedbackMap = new Map<string, RecommendationFeedback>()
  feedback.forEach((entry) => { const key = feedbackMediaKey(entry); if (entry.kind !== 'hide-genre' && !feedbackMap.has(key)) feedbackMap.set(key, entry) })
  const relatedFeedbackByGenre = new Map<number, Array<{ index: number; kind: RecommendationFeedback['kind']; mediaKey: string }>>()
  feedback.forEach((entry, index) => {
    if (entry.kind !== 'more-like-this' && entry.kind !== 'less-like-this' && entry.kind !== 'not-interested') return
    for (const genreId of new Set(entry.item.genreIds || [])) {
      const entries = relatedFeedbackByGenre.get(genreId) || []
      entries.push({ index, kind: entry.kind, mediaKey: feedbackMediaKey(entry) })
      relatedFeedbackByGenre.set(genreId, entries)
    }
  })
  const hiddenGenres = new Set(feedback.filter((entry) => entry.kind === 'hide-genre').flatMap((entry) => entry.genreId == null ? entry.item.genreIds || [] : [entry.genreId]))
  // User weight nudges scale a dimension: -1 → suppress (×0), 0 → preset (×1), +1 → ×2
  const wGenre = 1 + (weights.genre || 0)
  const wKeyword = 1 + (weights.keyword || 0)
  const wPeople = 1 + (weights.people || 0)
  const wQuality = 1 + (weights.quality || 0)
  const wPopularity = 1 + (weights.popularity || 0)
  const wNovelty = 1 + (weights.novelty || 0)
  const wRecency = 1 + (weights.recency || 0)
  const wEra = 1 + (weights.era || 0)
  const wLanguage = 1 + (weights.language || 0)
  const ranked = uniqueCandidates.map((candidate) => {
    const item = candidate.item
    const key = mediaKey(item)
    const itemFeedback = feedbackMap.get(key)
    const genreAffinity = (item.genreIds || []).reduce((sum, id) => sum + (profile.genreWeights[id] || 0), 0)
    const itemKeywords = extractKeywords(`${item.title} ${item.overview || ''}`)
    const keywordAffinity = [...itemKeywords].reduce((sum, keyword) => sum + (profile.keywordWeights[keyword] || 0), 0)
      / Math.max(2, profile.activityCount)
      / Math.sqrt(Math.max(1, itemKeywords.size))
    const keywordScore = Math.max(-10, Math.min(10, keywordAffinity * 32)) * wKeyword
    const formatAffinity=item.type==='movie'?profile.movieWeight:profile.seriesWeight
    const languageAffinity=item.originalLanguage?(profile.languageWeights[item.originalLanguage]||0):0
    const countryAffinity=(item.originCountry||[]).reduce((sum,country)=>sum+(profile.countryWeights[country]||0),0)
    const peopleAffinity = [...(candidate.cast || []), ...(candidate.directors || [])].reduce((sum, person) => sum + (profile.personWeights[person.trim()] || 0), 0)

    // Genre preference
    const preference = Math.min(28, (genreAffinity * RECOMMENDATION_WEIGHTS.genreAffinity + formatAffinity + countryAffinity) / Math.max(2, profile.activityCount)) * wGenre + keywordScore

    // Decade/Era affinity
    const decade = item.year ? `${Math.floor(item.year / 10) * 10}s` : null
    const decadeAffinity = decade ? (profile.decadeWeights[decade] || 0) : 0
    const eraScore = (decadeAffinity * 2.0) * wEra

    // Language affinity
    const languageScore = (languageAffinity * 3.0) * wLanguage

    // People (cast / director seeds)
    const isPeopleSeed = candidate.source === 'tmdb-cast' || candidate.source === 'tmdb-director'
    const peopleScore = ((isPeopleSeed ? 8 : 0) + Math.min(16, peopleAffinity * 2)) * wPeople

    // Recency (similar seeds / actor/director from recent watches)
    const isRecentSeed = candidate.source === 'tmdb-similar' || candidate.source === 'tmdb-cast' || candidate.source === 'tmdb-director'
    const recencyScore = (isRecentSeed ? 6 : 0) * wRecency

    // Quality
    const quality = Math.max(0, ((item.rating || 5) - 5) * RECOMMENDATION_WEIGHTS.quality) * wQuality
    const releaseYear = recommendationReleaseYear(item, now)
    const yearAge = releaseYear ? Math.max(0, new Date(now).getFullYear() - releaseYear) : 8
    const novelty = (Math.max(0, 8 - Math.min(8, yearAge)) / 2) * wNovelty
    // Use a stable popularity scale across candidate pools. Relative
    // normalization made a low-momentum title look like a blockbuster when
    // the current pool happened to contain only older or niche titles.
    const popularityMomentum = popularitySignal(candidate.popularity) * 20 * wPopularity
    const trendSourceBoost = candidate.trendSignal || candidate.source === 'tmdb-trending' ? 28 * wPopularity : 0
    const trend = Math.max(popularityMomentum, trendSourceBoost)
    const releaseFreshness = item.year ? Math.max(0, 1 - yearAge / 6) * 5 * wRecency : 0
    const hiddenGem = candidate.popularity != null && candidate.popularity < 35 && (item.rating || 0) >= 7
    const quick = (candidate.runtimeMinutes || 999) <= (item.type === 'movie' ? 105 : 40)
    const runtimeScore = profile.preferredRuntimeMinutes && candidate.runtimeMinutes
      ? Math.max(-5, 7 - Math.abs(candidate.runtimeMinutes - profile.preferredRuntimeMinutes) / 18)
      : 0
    const ignoredPenalty = -Math.min(6, Math.max(0, (impressions[key] || 0) - 2) * .75)
    const exploration = (profile.activityCount < 3 || genreAffinity === 0 ? RECOMMENDATION_WEIGHTS.exploration : 0) + ignoredPenalty
    const tmdbId = normalizedTmdbId(item.tmdbId)
    const imdbId = normalizedImdbId(item.imdbId)
    const watched = completed.has(item.id) || Boolean(tmdbId && completed.has(tmdbId)) || Boolean(imdbId && completed.has(imdbId))
    const rewatchSuitable=rewatchKeys.has(item.id)||Boolean(tmdbId&&rewatchKeys.has(tmdbId))||Boolean(imdbId&&rewatchKeys.has(imdbId))
    const explicitFeedback = itemFeedback ? (itemFeedback.kind === 'more-like-this' ? RECOMMENDATION_WEIGHTS.explicitPositive : itemFeedback.kind === 'already-seen' ? -45 : itemFeedback.kind === 'less-like-this' ? -22 : RECOMMENDATION_WEIGHTS.explicitNegative) : 0
    const relatedFeedbackIndices = new Set<number>()
    let relatedFeedback = 0
    for (const genreId of new Set(item.genreIds || [])) {
      for (const entry of relatedFeedbackByGenre.get(genreId) || []) {
        if (entry.mediaKey === key) continue
        if (relatedFeedbackIndices.has(entry.index)) continue
        relatedFeedbackIndices.add(entry.index)
        relatedFeedback += entry.kind === 'more-like-this' ? 6 : -5
      }
    }
    const genreHidden = (item.genreIds || []).some((id) => hiddenGenres.has(id))
    const feedbackPenalty = explicitFeedback + relatedFeedback + (genreHidden ? RECOMMENDATION_WEIGHTS.explicitNegative : 0)
    let modeBonus = 0
    if (mode === 'new') modeBonus = genreAffinity === 0 ? 14 : -preference * .35
    if (mode === 'hidden-gems') modeBonus = hiddenGem ? 18 : -(candidate.popularity || 0) / 15
    if (mode === 'critically-acclaimed') modeBonus = quality * 1.5
    if (mode === 'recently-released') modeBonus = novelty * 4
    if (mode === 'quick-watch') modeBonus = quick ? 18 : -8
    const availability=item.title&&(item.poster||item.backdrop)&&item.tmdbId!=null?4:-15
    const score: RecommendationScore = { total: 0, contentSimilarity: preference, preference: preference + languageScore + eraScore + peopleScore + runtimeScore + recencyScore + releaseFreshness, recency: novelty, quality, trend, popularityConfidence: Math.min(6, Math.log10((candidate.voteCount || 10) + 1) * 2) * wPopularity, availability, novelty, exploration: exploration + modeBonus, feedbackPenalty, watchedPenalty: watched ? (rewatchSuitable?-5:-100) : 0 }
    score.total = Object.entries(score).filter(([name]) => name !== 'total').reduce((sum, [,value]) => sum + value, 48)
    const reasons: RecommendationReason[] = []
    if (candidate.source === 'tmdb-similar' && candidate.seedTitle) reasons.push({code:'recent-interest',label:`Because you ${candidate.seedKind === 'favorited' ? 'favorited' : 'watched'} ${candidate.seedTitle}`,strength:12})
    if (candidate.source === 'tmdb-cast' && candidate.seedTitle) reasons.push({code:'recent-interest',label:`Featuring ${candidate.seedTitle}, from titles you watch`,strength:10})
    if (candidate.source === 'tmdb-director' && candidate.seedTitle) reasons.push({code:'recent-interest',label:`From ${candidate.seedTitle}, a creator in your recent watches`,strength:11})
    const matchingPerson = [...(candidate.cast || []), ...(candidate.directors || [])].sort((a,b) => (profile.personWeights[b.trim()] || 0) - (profile.personWeights[a.trim()] || 0))[0]
    if (matchingPerson && profile.personWeights[matchingPerson.trim()] > 0) reasons.push({code:'person-affinity',label:`Featuring ${matchingPerson}, from titles you enjoy`,strength:peopleScore})
    const strongestGenre = [...(item.genreIds || [])].sort((a,b) => (profile.genreWeights[b] || 0) - (profile.genreWeights[a] || 0))[0]
    if (strongestGenre && profile.genreWeights[strongestGenre]) reasons.push({ code:'genre-affinity', label:`Matches your interest in ${GENRES[strongestGenre] || 'similar stories'}`, strength: preference })
    if (keywordScore >= 2) reasons.push({ code:'keyword-affinity', label:'Matches themes in titles you enjoy', strength: keywordScore })
    if (candidate.trendSignal || candidate.source === 'tmdb-trending') reasons.push({ code:'trend', label:'Trending this week', strength: trend })
    else if ((candidate.popularity || 0) >= 50 && trend >= 5) reasons.push({ code:'popularity', label:'Popular right now', strength: trend })
    if (quality >= 5) reasons.push({ code:'quality', label:'Highly rated by viewers', strength: quality })
    if (hiddenGem) reasons.push({ code:'hidden-gem', label:'A highly rated title that is easy to miss', strength: 8 })
    if (quick && mode === 'quick-watch') reasons.push({ code:'quick-watch', label:'Fits a shorter watch session', strength: 8 })
    if(rewatchSuitable)reasons.push({code:'rewatch',label:'Worth revisiting based on your rewatch history',strength:7})
    if (runtimeScore >= 4) reasons.push({code:'runtime-affinity',label:'Fits your usual watch length',strength:runtimeScore})
    if (!reasons.length) reasons.push({ code:'exploration', label: profile.confidence === 'low' ? 'A broad pick while Aurales learns your taste' : 'Adds variety to your recommendations', strength: 2 })
    return { ...candidate, score, matchPercent: Math.max(50, Math.min(99, Math.round(score.total))), reasons: reasons.sort((a,b) => b.strength-a.strength) }
  }).filter((entry) => entry.score.feedbackPenalty > -90 && entry.score.availability > -10 && entry.score.watchedPenalty > -90).sort((a,b) => b.score.total-a.score.total)

  if (mode === 'for-you') return ranked

  let eligible: RankedRecommendation[] = []
  if (mode === 'hidden-gems') {
    eligible = ranked.filter((entry) => entry.popularity != null && entry.popularity < 40 && (entry.item.rating || 0) >= 7 && (entry.voteCount || 0) >= 80)
      .sort((a,b) => (b.item.rating || 0) - (a.item.rating || 0) || (a.popularity || 0) - (b.popularity || 0))
  } else if (mode === 'critically-acclaimed') {
    eligible = ranked.filter((entry) => (entry.item.rating || 0) >= 7.5 && (entry.voteCount || 0) >= 250)
      .sort((a,b) => (b.item.rating || 0) - (a.item.rating || 0) || (b.voteCount || 0) - (a.voteCount || 0))
  } else if (mode === 'recently-released') {
    eligible = ranked.filter((entry) => isRecentlyReleased(entry.item, now))
      .sort((a,b) => compareReleaseRecency(a.item, b.item) || (b.popularity || 0) - (a.popularity || 0) || b.score.total - a.score.total)
  } else if (mode === 'quick-watch') {
    eligible = ranked.filter((entry) => entry.runtimeMinutes != null && entry.runtimeMinutes <= (entry.item.type === 'movie' ? 105 : 40))
      .sort((a,b) => (a.runtimeMinutes || 999) - (b.runtimeMinutes || 999) || b.score.total - a.score.total)
  } else if (mode === 'new') {
    const affinityValues = ranked.map((entry) => entry.score.contentSimilarity).sort((a,b) => a-b)
    const medianAffinity = affinityValues[Math.floor(affinityValues.length / 2)] || 0
    eligible = ranked.filter((entry) => entry.score.contentSimilarity <= medianAffinity && entry.source !== 'tmdb-similar')
      .sort((a,b) => a.score.contentSimilarity - b.score.contentSimilarity || b.score.novelty - a.score.novelty || b.score.total - a.score.total)
  }

  // Keep the mode usable with small caches, but never fall back to the exact
  // default ordering: mode-specific ordering still leads the available pool.
  if (eligible.length >= 3 || mode === 'recently-released') return eligible
  const eligibleKeys = new Set(eligible.map((entry) => mediaKey(entry.item)))
  return [...eligible, ...ranked.filter((entry) => !eligibleKeys.has(mediaKey(entry.item)))].sort((a,b) => {
    if (mode === 'quick-watch') return (a.runtimeMinutes || 999) - (b.runtimeMinutes || 999)
    if (mode === 'critically-acclaimed') return (b.item.rating || 0) - (a.item.rating || 0)
    if (mode === 'hidden-gems') return (a.popularity ?? Number.MAX_SAFE_INTEGER) - (b.popularity ?? Number.MAX_SAFE_INTEGER)
    return a.score.contentSimilarity - b.score.contentSimilarity
  })
}

/**
 * Updates a persisted recommendation snapshot as soon as feedback is saved.
 * It intentionally uses only persisted card metadata, so callers do not need
 * to wait for provider candidates or rebuild the full activity profile.
 */
export function applyRecommendationFeedback(snapshot: RankedRecommendation[], feedback: RecommendationFeedback[]): RankedRecommendation[] {
  const latest = new Map<string, RecommendationFeedback>()
  const hiddenGenres = new Set<number>()
  feedback.forEach((entry) => {
    if (entry.kind === 'hide-genre') {
      ;(entry.genreId == null ? entry.item.genreIds || [] : [entry.genreId]).forEach((id) => hiddenGenres.add(id))
    } else {
      const key = feedbackMediaKey(entry)
      if (!latest.has(key)) latest.set(key, entry)
    }
  })
  return snapshot
    .filter((entry) => {
      const feedbackEntry = latest.get(mediaKey(entry.item))
      return feedbackEntry?.kind !== 'hide' && feedbackEntry?.kind !== 'not-interested' && feedbackEntry?.kind !== 'already-seen' && !(entry.item.genreIds || []).some((id) => hiddenGenres.has(id))
    })
    .map((entry) => {
      const key = mediaKey(entry.item)
      const own = latest.get(key)
      const related = feedback.reduce((sum, value) => {
        if (feedbackMediaKey(value) === key || !value.item.genreIds?.some((id) => entry.item.genreIds?.includes(id))) return sum
        if (value.kind === 'more-like-this') return sum + 6
        if (value.kind === 'less-like-this') return sum - 5
        return sum
      }, 0)
      const ownDelta = own?.kind === 'more-like-this' ? RECOMMENDATION_WEIGHTS.explicitPositive : own?.kind === 'less-like-this' ? -22 : 0
      const delta = ownDelta + related
      return delta ? { ...entry, score: { ...entry.score, total: entry.score.total + delta, feedbackPenalty: entry.score.feedbackPenalty + delta }, matchPercent: Math.max(50, Math.min(99, Math.round(entry.score.total + delta))) } : entry
    })
    .sort((a,b) => b.score.total - a.score.total || mediaKey(a.item).localeCompare(mediaKey(b.item)))
}

export function generateDiscoverySections(ranked: RankedRecommendation[], _profile: TasteProfile, mode: DiscoveryMode, minSize = 5, now = Date.now()): DiscoverySection[] {
  const used = new Set<string>()
  // Keep one broad section from exhausting the entire ranked pool before the
  // specialized catalogs get a chance to select their titles.
  const take = (predicate: (item: RankedRecommendation) => boolean, count = 10) => ranked.filter((item) => predicate(item) && !used.has(mediaKey(item.item))).slice(0, count).filter((item) => { used.add(mediaKey(item.item)); return true })
  const similaritySeed=ranked.find((item)=>item.source==='tmdb-similar'&&item.seedTitle&&item.seedKind==='favorited')
    ?? ranked.find((item)=>item.source==='tmdb-similar'&&item.seedTitle)
  const mainTitle = mode === 'for-you' ? 'Recommended'
    : mode === 'new' || mode === 'recently-released' ? 'New & Trending'
      : mode === 'hidden-gems' ? 'Hidden Gems'
        : mode === 'critically-acclaimed' ? 'Critically Acclaimed'
          : 'Quick Watches'
  const similarityDefinition: [string, string, (item: RankedRecommendation) => boolean] | undefined = similaritySeed
    ? [
      similaritySeed.seedKind === 'favorited' ? 'because-favorited' : 'because-watched',
      `Because You ${similaritySeed.seedKind === 'favorited' ? 'Favorited' : 'Watched'} ${similaritySeed.seedTitle}`,
      (item) => item.source === 'tmdb-similar' && item.seedKind === similaritySeed.seedKind && item.seedTitle === similaritySeed.seedTitle,
    ]
    : undefined
  // Weekly TMDB trending is a general catalog source, independent from user
  // history. Give it a visible shelf while reserving those titles from the
  // broad recommendation shelf so the same cards do not appear twice.
  const trendingCatalog = ranked
    .filter((item) => item.trendSignal || item.source === 'tmdb-trending')
    // Keep this rail faithful to the public trending feed even when the user
    // switches the recommendation mode or sort preference. Within the feed,
    // popularity is the strongest available signal for what is broadly hot.
    .sort((left, right) => Number(Boolean(right.trendSignal || right.source === 'tmdb-trending')) - Number(Boolean(left.trendSignal || left.source === 'tmdb-trending'))
      || (right.popularity || 0) - (left.popularity || 0)
      || right.score.total - left.score.total)
  const trendingCandidates = trendingCatalog.slice(0, 10)
  // Avoid dropping a small trend response when the shelf would be hidden by
  // the minimum-size rule below. Fold it into Recommended until it can stand
  // as a useful, independently browsable row.
  const trending = trendingCandidates.length >= minSize ? trendingCandidates : []
  const trendingKeys = new Set(trending.map((item) => mediaKey(item.item)))
  const broadCatalog = ranked.filter((item) => item.source !== 'tmdb-similar' && !trendingKeys.has(mediaKey(item.item)))
  const broad = broadCatalog.slice(0, 10)
  const definitions: Array<[string,string,(item:RankedRecommendation)=>boolean]> = [
    ['made-for-you', mainTitle, (item) => broad.includes(item)],
    ['trending-this-week', 'Trending This Week', (item) => trending.includes(item)],
    ...(similarityDefinition ? [similarityDefinition] : []),
    ['hidden-gems','Hidden Gems',(item) => item.popularity != null && item.popularity < 35 && (item.item.rating || 0) >= 7],
    ['new','Recently Released',(item) => isRecentlyReleased(item.item, now)],
  ]
  const filteredDefinitions = definitions.filter(([id]) => !(mode === 'hidden-gems' && id === 'hidden-gems') && ((mode !== 'new' && mode !== 'recently-released') || id !== 'new'))
  return filteredDefinitions.map(([id,title,predicate]) => {
    const catalogItems = id === 'made-for-you' ? broadCatalog
      : id === 'trending-this-week' ? trendingCatalog
        : ranked.filter((item) => predicate(item) && !used.has(mediaKey(item.item)))
    const items = id === 'made-for-you' ? broad : id === 'trending-this-week' ? trending : take(predicate)
    items.forEach((item) => used.add(mediaKey(item.item)))
    return { id, title, items, catalogItems }
  }).filter((section) => section.items.length >= minSize)
}

/** High-confidence, highly rated titles from the already-loaded discovery pool. */
export function selectTopRatedRecommendations(ranked: RankedRecommendation[], limit = 10): RankedRecommendation[] {
  return ranked
    .filter((entry) => (entry.item.rating || 0) >= 7.5 && (entry.voteCount || 0) >= 250 && Boolean(entry.item.poster || entry.item.backdrop))
    .sort((left, right) => (right.item.rating || 0) - (left.item.rating || 0)
      || (right.voteCount || 0) - (left.voteCount || 0)
      || (right.popularity || 0) - (left.popularity || 0)
      || right.score.total - left.score.total)
    .slice(0, Math.max(0, limit))
}

/** Prefer live trends, popular and fresh discoveries while preserving choice. */
export function chooseSurpriseRecommendation(pool: RankedRecommendation[], currentId?: string | number, random = Math.random): RankedRecommendation | undefined {
  if (!pool.length) return undefined
  const alternatives = pool.filter((entry) => String(entry.item.id) !== String(currentId))
  const choices = alternatives.length ? alternatives : pool
  const year = new Date().getFullYear()
  const weights = choices.map((entry, index) => {
    // Keep popularity on an absolute scale. Normalizing to the current pool's
    // maximum made a stale title look like a blockbuster whenever every item
    // in the pool was stale. 250 is a conservative high-popularity reference
    // for TMDB's field; values above it remain top-tier without dominating.
    const popularity = popularitySignal(entry.popularity)
    // score.trend also contains a popularity-derived component. Use source
    // provenance here so popularity is counted once and live weekly trends
    // receive their own clear preference.
    const isWeeklyTrend = entry.trendSignal || entry.source === 'tmdb-trending'
    const releaseYear = recommendationReleaseYear(entry.item, Date.now())
    const age = releaseYear ? Math.max(0, year - releaseYear) : 8
    const freshness = Math.max(0, 1 - age / 6)
    const rankPreference = choices.length > 1 ? 1 - index / (choices.length - 1) : 1
    // Live trends and established hits lead the draw, while fresh releases
    // still beat equally popular catalogue staples. A fresh obscure title
    // does not crowd out a known hit, and old low-momentum titles stay rare.
    return 1 + popularity * 14 + (isWeeklyTrend ? 24 : 0) + freshness * 9 + rankPreference * .25
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let target = Math.min(.999999999, Math.max(0, random())) * total
  for (let index = 0; index < choices.length; index += 1) {
    target -= weights[index]!
    if (target < 0) return choices[index]
  }
  return choices[choices.length - 1]
}

/** Pick a distinct animation frame while saving the final winner for the end. */
export function chooseSurpriseAnimationFrame(
  pool: RankedRecommendation[],
  winnerId: string | number,
  previousId?: string | number,
  random = Math.random,
): RankedRecommendation | undefined {
  const winnerKey = String(winnerId)
  const previousKey = previousId == null ? undefined : String(previousId)
  const nonWinningFrames = pool.filter((entry) => String(entry.item.id) !== winnerKey && String(entry.item.id) !== previousKey)
  const anyDifferentFrame = pool.filter((entry) => String(entry.item.id) !== previousKey)
  return chooseSurpriseRecommendation(nonWinningFrames.length ? nonWinningFrames : anyDifferentFrame, previousId, random)
}
