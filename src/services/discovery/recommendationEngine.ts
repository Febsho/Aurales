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

const GENRES: Record<number, string> = { 28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',10752:'War',37:'Western',10759:'Action & Adventure',10762:'Kids',10763:'News',10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics' }

export function mediaKey(item: Pick<SearchResult, 'id' | 'type' | 'tmdbId' | 'imdbId'>): string {
  if (item.tmdbId != null) return `${item.type}:tmdb:${item.tmdbId}`
  if (item.imdbId) return `${item.type}:imdb:${item.imdbId}`
  return `${item.type}:local:${item.id}`
}

export function buildTasteProfile(activity: DiscoveryActivity, now = Date.now()): TasteProfile {
  const genreWeights: Record<number, number> = {}
  const decadeWeights: Record<string, number> = {}, languageWeights:Record<string,number>={}, countryWeights:Record<string,number>={}
  let movieWeight = 0, seriesWeight = 0, animeWeight = 0
  const add = (item: SearchResult, weight: number) => {
    item.genreIds?.forEach((id) => { genreWeights[id] = (genreWeights[id] || 0) + weight })
    if (item.year) { const decade = `${Math.floor(item.year / 10) * 10}s`; decadeWeights[decade] = (decadeWeights[decade] || 0) + weight }
    if(item.originalLanguage)languageWeights[item.originalLanguage]=(languageWeights[item.originalLanguage]||0)+weight
    item.originCountry?.forEach((country)=>{countryWeights[country]=(countryWeights[country]||0)+weight})
    if (item.type === 'movie') movieWeight += weight
    else seriesWeight += weight
    if (item.isAnime) animeWeight += weight
  }
  activity.recent.forEach((item, index) => add(item, RECOMMENDATION_WEIGHTS.recent * Math.exp(-index / 12)))
  activity.ratings?.forEach(({item,rating}) => add(item, rating >= 8 ? 5 : rating >= 6 ? 1.5 : rating <= 4 ? -4 : 0))
  activity.watchlist?.forEach((item)=>add(item,1.8))
  activity.rewatches?.forEach((item)=>add(item,7))
  activity.bingeItems?.forEach((item)=>add(item,4))
  activity.progress.forEach((progress) => {
    const ratio = progress.durationSeconds > 0 ? progress.progressSeconds / progress.durationSeconds : 0
    const weight = progress.completed ? RECOMMENDATION_WEIGHTS.completed : ratio > .08 && ratio < .2 ? RECOMMENDATION_WEIGHTS.abandoned : RECOMMENDATION_WEIGHTS.inProgress
    const recentItem = activity.recent.find((item) => [item.id, String(item.tmdbId || ''), item.imdbId].includes(String(progress.mediaId)))
    if (recentItem) add(recentItem, weight)
  })
  const activityCount = activity.recent.length + activity.progress.length
  const signals:TasteSignal[] = Object.entries(genreWeights).sort((a,b) => b[1]-a[1]).slice(0, 6).map(([id, weight]) => ({ kind: 'genre' as const, value: GENRES[Number(id)] || `Genre ${id}`, weight, evidenceCount: Math.max(1, Math.round(Math.abs(weight) / 2)) }))
  Object.entries(decadeWeights).sort((a,b)=>b[1]-a[1]).slice(0,1).forEach(([value,weight])=>signals.push({kind:'decade',value,weight,evidenceCount:Math.max(1,Math.round(Math.abs(weight)/2))}))
  if(animeWeight>2)signals.push({kind:'anime',value:'Anime',weight:animeWeight,evidenceCount:Math.max(1,Math.round(animeWeight/2))})
  const preferredFormat:[string,number]=movieWeight>seriesWeight?['Movies',movieWeight]:['Series',seriesWeight]
  if(Number(preferredFormat[1])>2)signals.push({kind:'format',value:String(preferredFormat[0]),weight:Number(preferredFormat[1]),evidenceCount:Math.max(1,Math.round(Number(preferredFormat[1])/2))})
  return { signals, genreWeights, decadeWeights, languageWeights, countryWeights, movieWeight, seriesWeight, animeWeight, activityCount, confidence: activityCount < 3 ? 'low' : activityCount < 12 ? 'medium' : 'high', generatedAt: now }
}

function watchedKeys(activity: DiscoveryActivity): Set<string> {
  const keys = new Set<string>()
  activity.progress.filter((p) => p.completed).forEach((p) => { keys.add(String(p.mediaId)); if (p.tmdbId) keys.add(String(p.tmdbId)); if (p.imdbId) keys.add(p.imdbId) })
  return keys
}

export function dedupeCandidates(candidates: RecommendationCandidate[]): RecommendationCandidate[] {
  const merged = new Map<string,RecommendationCandidate>()
  for(const candidate of candidates){const key=mediaKey(candidate.item);const existing=merged.get(key);if(!existing){merged.set(key,candidate);continue}const informativeSource=candidate.source==='tmdb-similar'||candidate.source==='tmdb-cast'||candidate.source==='tmdb-director';merged.set(key,{...existing,source:informativeSource?candidate.source:existing.source,item:{...candidate.item,...existing.item,genreIds:existing.item.genreIds||candidate.item.genreIds,genres:existing.item.genres||candidate.item.genres},runtimeMinutes:existing.runtimeMinutes??candidate.runtimeMinutes,voteCount:existing.voteCount??candidate.voteCount,popularity:existing.popularity??candidate.popularity,releaseDate:existing.releaseDate??candidate.releaseDate,seedTitle:existing.seedTitle??candidate.seedTitle})}
  return [...merged.values()]
}

export function rankCandidates(candidates: RecommendationCandidate[], profile: TasteProfile, activity: DiscoveryActivity, feedback: RecommendationFeedback[], mode: DiscoveryMode, now = Date.now(), impressions: Record<string,number> = {}): RankedRecommendation[] {
  const completed = watchedKeys(activity)
  const rewatchKeys=new Set((activity.rewatches||[]).flatMap((item)=>[item.id,String(item.tmdbId||''),item.imdbId||'']).filter(Boolean))
  const feedbackMap = new Map(feedback.map((entry) => [entry.mediaKey, entry]))
  const ranked = dedupeCandidates(candidates).map((candidate) => {
    const item = candidate.item
    const key = mediaKey(item)
    const itemFeedback = feedbackMap.get(key)
    const genreAffinity = (item.genreIds || []).reduce((sum, id) => sum + (profile.genreWeights[id] || 0), 0)
    const formatAffinity=item.type==='movie'?profile.movieWeight:profile.seriesWeight
    const languageAffinity=item.originalLanguage?(profile.languageWeights[item.originalLanguage]||0):0
    const countryAffinity=(item.originCountry||[]).reduce((sum,country)=>sum+(profile.countryWeights[country]||0),0)
    const preference = Math.min(28, (genreAffinity * RECOMMENDATION_WEIGHTS.genreAffinity + formatAffinity + languageAffinity + countryAffinity) / Math.max(2, profile.activityCount))
    const quality = Math.max(0, ((item.rating || 5) - 5) * RECOMMENDATION_WEIGHTS.quality)
    const yearAge = item.year ? Math.max(0, new Date(now).getFullYear() - item.year) : 8
    const novelty = Math.max(0, 8 - Math.min(8, yearAge)) / 2
    const hiddenGem = (candidate.popularity || 0) < 35 && (item.rating || 0) >= 7
    const quick = (candidate.runtimeMinutes || 999) <= (item.type === 'movie' ? 105 : 40)
    const ignoredPenalty = -Math.min(6, Math.max(0, (impressions[key] || 0) - 2) * .75)
    const exploration = (profile.activityCount < 3 || genreAffinity === 0 ? RECOMMENDATION_WEIGHTS.exploration : 0) + ignoredPenalty
    const watched = completed.has(item.id) || completed.has(String(item.tmdbId || '')) || Boolean(item.imdbId && completed.has(item.imdbId))
    const rewatchSuitable=rewatchKeys.has(item.id)||rewatchKeys.has(String(item.tmdbId||''))||Boolean(item.imdbId&&rewatchKeys.has(item.imdbId))
    const explicitFeedback = itemFeedback ? (itemFeedback.kind === 'more-like-this' ? RECOMMENDATION_WEIGHTS.explicitPositive : itemFeedback.kind === 'already-seen' ? -45 : itemFeedback.kind === 'less-like-this' ? -22 : RECOMMENDATION_WEIGHTS.explicitNegative) : 0
    const relatedFeedback = feedback.reduce((sum, entry) => {
      if (entry.mediaKey === key || !entry.item.genreIds?.some((id) => item.genreIds?.includes(id))) return sum
      if (entry.kind === 'more-like-this') return sum + 6
      if (entry.kind === 'less-like-this' || entry.kind === 'not-interested') return sum - 5
      return sum
    }, 0)
    const feedbackPenalty = explicitFeedback + relatedFeedback
    let modeBonus = 0
    if (mode === 'new') modeBonus = genreAffinity === 0 ? 14 : -preference * .35
    if (mode === 'hidden-gems') modeBonus = hiddenGem ? 18 : -(candidate.popularity || 0) / 15
    if (mode === 'critically-acclaimed') modeBonus = quality * 1.5
    if (mode === 'recently-released') modeBonus = novelty * 4
    if (mode === 'quick-watch') modeBonus = quick ? 18 : -8
    const availability=item.title&&(item.poster||item.backdrop)&&item.tmdbId!=null?4:-15
    const score: RecommendationScore = { total: 0, contentSimilarity: preference, preference, recency: novelty, quality, popularityConfidence: Math.min(6, Math.log10((candidate.voteCount || 10) + 1) * 2), availability, novelty, exploration: exploration + modeBonus, feedbackPenalty, watchedPenalty: watched ? (rewatchSuitable?-5:-100) : 0 }
    score.total = Object.entries(score).filter(([name]) => name !== 'total').reduce((sum, [,value]) => sum + value, 48)
    const reasons: RecommendationReason[] = []
    if (candidate.source === 'tmdb-similar' && candidate.seedTitle) reasons.push({code:'recent-interest',label:`Because you watched ${candidate.seedTitle}`,strength:12})
    if (candidate.source === 'tmdb-cast' && candidate.seedTitle) reasons.push({code:'recent-interest',label:`Featuring ${candidate.seedTitle}, from titles you watch`,strength:10})
    if (candidate.source === 'tmdb-director' && candidate.seedTitle) reasons.push({code:'recent-interest',label:`From ${candidate.seedTitle}, a creator in your recent watches`,strength:11})
    const strongestGenre = (item.genreIds || []).sort((a,b) => (profile.genreWeights[b] || 0) - (profile.genreWeights[a] || 0))[0]
    if (strongestGenre && profile.genreWeights[strongestGenre]) reasons.push({ code:'genre-affinity', label:`Matches your interest in ${GENRES[strongestGenre] || 'similar stories'}`, strength: preference })
    if (quality >= 5) reasons.push({ code:'quality', label:'Highly rated by viewers', strength: quality })
    if (hiddenGem) reasons.push({ code:'hidden-gem', label:'A highly rated title that is easy to miss', strength: 8 })
    if (quick && mode === 'quick-watch') reasons.push({ code:'quick-watch', label:'Fits a shorter watch session', strength: 8 })
    if(rewatchSuitable)reasons.push({code:'rewatch',label:'Worth revisiting based on your rewatch history',strength:7})
    if (!reasons.length) reasons.push({ code:'exploration', label: profile.confidence === 'low' ? 'A broad pick while Aurales learns your taste' : 'Adds variety to your recommendations', strength: 2 })
    return { ...candidate, score, matchPercent: Math.max(50, Math.min(99, Math.round(score.total))), reasons: reasons.sort((a,b) => b.strength-a.strength) }
  }).filter((entry) => entry.score.feedbackPenalty > -90 && entry.score.availability > -10 && entry.score.watchedPenalty > -90).sort((a,b) => b.score.total-a.score.total)

  const currentYear = new Date(now).getFullYear()
  if (mode === 'for-you') return ranked

  let eligible: RankedRecommendation[] = []
  if (mode === 'hidden-gems') {
    eligible = ranked.filter((entry) => entry.popularity != null && entry.popularity < 40 && (entry.item.rating || 0) >= 7 && (entry.voteCount || 0) >= 80)
      .sort((a,b) => (b.item.rating || 0) - (a.item.rating || 0) || (a.popularity || 0) - (b.popularity || 0))
  } else if (mode === 'critically-acclaimed') {
    eligible = ranked.filter((entry) => (entry.item.rating || 0) >= 7.5 && (entry.voteCount || 0) >= 250)
      .sort((a,b) => (b.item.rating || 0) - (a.item.rating || 0) || (b.voteCount || 0) - (a.voteCount || 0))
  } else if (mode === 'recently-released') {
    eligible = ranked.filter((entry) => (entry.item.year || 0) >= currentYear - 1)
      .sort((a,b) => (b.item.year || 0) - (a.item.year || 0) || b.score.total - a.score.total)
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
  if (eligible.length >= 3) return eligible
  const eligibleKeys = new Set(eligible.map((entry) => mediaKey(entry.item)))
  return [...eligible, ...ranked.filter((entry) => !eligibleKeys.has(mediaKey(entry.item)))].sort((a,b) => {
    if (mode === 'quick-watch') return (a.runtimeMinutes || 999) - (b.runtimeMinutes || 999)
    if (mode === 'recently-released') return (b.item.year || 0) - (a.item.year || 0)
    if (mode === 'critically-acclaimed') return (b.item.rating || 0) - (a.item.rating || 0)
    if (mode === 'hidden-gems') return (a.popularity ?? Number.MAX_SAFE_INTEGER) - (b.popularity ?? Number.MAX_SAFE_INTEGER)
    return a.score.contentSimilarity - b.score.contentSimilarity
  })
}

export function generateDiscoverySections(ranked: RankedRecommendation[], profile: TasteProfile, mode: DiscoveryMode, minSize = 5): DiscoverySection[] {
  const used = new Set<string>()
  const take = (predicate: (item: RankedRecommendation) => boolean, count = 16) => ranked.filter((item) => predicate(item) && !used.has(mediaKey(item.item))).slice(0, count).filter((item) => { used.add(mediaKey(item.item)); return true })
  const similaritySeed=ranked.find((item)=>item.source==='tmdb-similar'&&item.seedTitle)?.seedTitle
  const definitions: Array<[string,string,(item:RankedRecommendation)=>boolean]> = [
    ['made-for-you', profile.confidence === 'low' ? 'Popular Right Now' : 'Made for You', () => true],
    ['because',similaritySeed?`Because You Watched ${similaritySeed}`:'More Like What You Watch',(item)=>item.source==='tmdb-similar'&&(!similaritySeed||item.seedTitle===similaritySeed)],
    ['directors','From Directors You Like',(item)=>item.source==='tmdb-director'],
    ['actors','Featuring Actors You Watch',(item)=>item.source==='tmdb-cast'],
    ['hidden-gems','Hidden Gems for You',(item) => (item.popularity || 0) < 35 && (item.item.rating || 0) >= 7],
    ['new','Recently Released for You',(item) => Boolean(item.item.year && item.item.year >= new Date().getFullYear()-1)],
    ['critics','Critically Acclaimed for You',(item) => (item.item.rating || 0) >= 7.5],
    ['quick','Short Watches for Tonight',(item) => (item.runtimeMinutes || 999) <= (item.item.type === 'movie' ? 105 : 40)],
    ['explore','Try Something Different',(item) => item.score.contentSimilarity < 4],
  ]
  if (mode !== 'for-you') definitions.unshift(['mode', mode.split('-').map((x)=>x[0].toUpperCase()+x.slice(1)).join(' '), () => true])
  return definitions.map(([id,title,predicate]) => ({ id, title, items: take(predicate) })).filter((section) => section.items.length >= minSize)
}
