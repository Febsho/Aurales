import { describe, expect, it } from 'vitest'
import type { SearchResult, WatchProgress } from '../../types'
import { applyRecommendationFeedback, buildTasteProfile, chooseSurpriseAnimationFrame, chooseSurpriseRecommendation, dedupeCandidates, generateDiscoverySections, mediaKey, rankCandidates, selectTopRatedRecommendations, trendingScopeFingerprint } from './recommendationEngine'
import type { DiscoveryActivity, RecommendationCandidate, RecommendationFeedback } from './types'

const sciFi: SearchResult = { id:'seed',title:'Seed',type:'movie',provider:'tmdb',tmdbId:1,genreIds:[878],year:2020,rating:8 }
const activity = (progress: WatchProgress[] = [], recent: SearchResult[] = [sciFi]): DiscoveryActivity => ({ progress, recent })
const candidate = (id:number, overrides:Partial<SearchResult> = {}): RecommendationCandidate => ({ item:{ id:`tmdb-${id}`,title:`Title ${id}`,type:'movie',provider:'tmdb',tmdbId:id,genreIds:[878],rating:8,year:2025,poster:`poster-${id}.jpg`,...overrides },source:'tmdb-discover',voteCount:1000,popularity:20,runtimeMinutes:95 })

describe('discovery recommendation engine', () => {
  it('refreshes the daily recommendation scope when live trend order or momentum changes', () => {
    const first = candidate(80, { popularity: 36, voteCount: 120 })
    const second = candidate(81, { popularity: 21, voteCount: 90 })
    const original = [first.item, second.item]
    const popularityChanged = [{ ...first.item, popularity: 18 }, second.item]
    const orderChanged = [second.item, first.item]

    expect(trendingScopeFingerprint(original)).not.toBe(trendingScopeFingerprint(popularityChanged))
    expect(trendingScopeFingerprint(original)).not.toBe(trendingScopeFingerprint(orderChanged))
    expect(trendingScopeFingerprint(original)).toBe(trendingScopeFingerprint([...original]))
  })
  it('builds useful public-catalog shelves with an empty library and no watch history', () => {
    const emptyActivity: DiscoveryActivity = { progress: [], recent: [] }
    const profile = buildTasteProfile(emptyActivity)
    const publicCatalog = Array.from({ length: 12 }, (_, index) => {
      const entry = candidate(90 + index, { year: 2020 + index % 6 })
      entry.popularity = 300 - index * 10
      return entry
    })
    const ranked = rankCandidates(publicCatalog, profile, emptyActivity, [], 'for-you')
    const sections = generateDiscoverySections(ranked, profile, 'for-you')

    expect(sections.find((section) => section.id === 'made-for-you')?.items).toHaveLength(10)
    expect(sections.find((section) => section.id === 'made-for-you')?.catalogItems).toHaveLength(12)
    expect(sections.find((section) => section.id === 'made-for-you')?.items[0]?.source).toBe('tmdb-discover')
    expect(sections.flatMap((section) => section.items).every((entry) => entry.source !== 'tmdb-similar')).toBe(true)
  })
  it('completed titles strengthen matching preferences', () => {
    const completed: WatchProgress = { id:'p',mediaId:'seed',mediaType:'movie',progressSeconds:100,durationSeconds:100,completed:true }
    expect(buildTasteProfile(activity([completed])).genreWeights[878]).toBeGreaterThan(buildTasteProfile(activity()).genreWeights[878])
  })
  it('prefers current popular titles in both ranking and Surprise Me selection', () => {
    const old = candidate(101, { year: 2010, rating: 8 })
    old.popularity = 1
    const fresh = candidate(102, { year: new Date().getFullYear(), rating: 8 })
    fresh.popularity = 250
    const profile = buildTasteProfile(activity())
    const ranked = rankCandidates([old, fresh], profile, activity(), [], 'for-you')
    expect(ranked[0]?.item.tmdbId).toBe(102)
    const oldFirst = [...ranked].sort((a, b) => Number(a.item.tmdbId) - Number(b.item.tmdbId))
    expect(chooseSurpriseRecommendation(oldFirst, undefined, () => 0.5)?.item.tmdbId).toBe(102)
  })
  it('keeps ordinary popularity on an absolute scale when the candidate pool changes', () => {
    const profile = buildTasteProfile(activity())
    const nicheArchive = candidate(130, { year: 2008, rating: 7 })
    nicheArchive.popularity = 2
    const blockbuster = candidate(131, { year: 2026, rating: 7 })
    blockbuster.popularity = 500

    const alone = rankCandidates([nicheArchive], profile, activity(), [], 'for-you')[0]
    const besideBlockbuster = rankCandidates([nicheArchive, blockbuster], profile, activity(), [], 'for-you')
      .find((entry) => entry.item.tmdbId === 130)

    expect(alone?.score.trend).toBeLessThan(5)
    expect(besideBlockbuster?.score.trend).toBe(alone?.score.trend)
  })
  it('gives a current title a better Surprise Me chance than an equally popular older title', () => {
    const currentYear = new Date().getFullYear()
    const old = candidate(103, { year: currentYear - 10, rating: 8 })
    const recent = candidate(104, { year: currentYear, rating: 8 })
    old.popularity = recent.popularity = 250
    const profile = buildTasteProfile(activity())
    const ranked = rankCandidates([old, recent], profile, activity(), [], 'for-you')
      .sort((left, right) => Number(left.item.tmdbId) - Number(right.item.tmdbId))

    // The deterministic draw falls after the old title's weighted segment
    // because the equally popular new title gets the freshness advantage.
    expect(chooseSurpriseRecommendation(ranked, undefined, () => 0.5)?.item.tmdbId).toBe(104)
    const draws = Array.from({ length: 1000 }, (_, index) => (index + 0.5) / 1000)
    const recentWins = draws.filter((draw) => chooseSurpriseRecommendation(ranked, undefined, () => draw)?.item.tmdbId === 104).length
    expect(recentWins).toBeGreaterThan(600)
  })
  it('uses exact release dates when recommendation entries have no year field', () => {
    const currentYear = new Date().getUTCFullYear()
    const today = new Date().toISOString().slice(0, 10)
    const recent = candidate(134, { year: undefined, releaseDate: today, rating: 8 })
    const archive = candidate(135, { year: undefined, releaseDate: `${currentYear - 10}-01-01`, rating: 8 })
    recent.popularity = archive.popularity = 80
    const ranked = rankCandidates([archive, recent], buildTasteProfile(activity()), activity(), [], 'for-you')
    const recentRanked = ranked.find((entry) => entry.item.tmdbId === 134)!
    const archiveRanked = ranked.find((entry) => entry.item.tmdbId === 135)!

    expect(recentRanked.score.recency).toBeGreaterThan(archiveRanked.score.recency)
    expect(recentRanked.score.preference).toBeGreaterThan(archiveRanked.score.preference)
    expect(recentRanked.score.total).toBeGreaterThan(archiveRanked.score.total)
    const draws = Array.from({ length: 1000 }, (_, index) => (index + 0.5) / 1000)
    const recentWins = draws.filter((draw) => chooseSurpriseRecommendation(ranked, undefined, () => draw)?.item.tmdbId === 134).length
    expect(recentWins).toBeGreaterThan(500)
  })
  it('lets an established popular title beat an obscure new release in Surprise Me', () => {
    const oldHit = candidate(107, { year: new Date().getFullYear() - 10, rating: 8 })
    oldHit.popularity = 250
    const newObscure = candidate(108, { year: new Date().getFullYear(), rating: 8 })
    newObscure.popularity = 0
    const profile = buildTasteProfile(activity())
    const ranked = rankCandidates([oldHit, newObscure], profile, activity(), [], 'for-you')
      .sort((left, right) => Number(left.item.tmdbId) - Number(right.item.tmdbId))

    expect(chooseSurpriseRecommendation(ranked, undefined, () => 0.5)?.item.tmdbId).toBe(107)
  })
  it('gives established hits a meaningfully higher chance than obscure new releases', () => {
    const oldHit = candidate(109, { year: new Date().getFullYear() - 10, rating: 8 })
    oldHit.popularity = 250
    const newObscure = candidate(110, { year: new Date().getFullYear(), rating: 8 })
    newObscure.popularity = 0
    const profile = buildTasteProfile(activity())
    const ranked = rankCandidates([oldHit, newObscure], profile, activity(), [], 'for-you')
      .sort((left, right) => Number(left.item.tmdbId) - Number(right.item.tmdbId))
    const draws = Array.from({ length: 1000 }, (_, index) => (index + 0.5) / 1000)
    const hitWins = draws.filter((draw) => chooseSurpriseRecommendation(ranked, undefined, () => draw)?.item.tmdbId === 109).length

    expect(hitWins).toBeGreaterThan(600)
  })
  it('gives a current weekly-trending title a stronger Surprise Me chance even without popularity metadata', () => {
    const ordinary = candidate(105, { year: 2020 })
    ordinary.popularity = 0
    const trending = candidate(106, { year: 2020 })
    trending.popularity = undefined
    trending.source = 'tmdb-trending'
    const profile = buildTasteProfile(activity())
    const [ordinaryRanked] = rankCandidates([ordinary], profile, activity(), [], 'for-you')
    const [trendingRanked] = rankCandidates([trending], profile, activity(), [], 'for-you')

    expect(chooseSurpriseRecommendation([ordinaryRanked!, trendingRanked!], undefined, () => 0.5)?.item.tmdbId).toBe(106)
  })
  it('keeps the Surprise Me animation moving when only two titles are available', () => {
    const pool = rankCandidates([candidate(132), candidate(133)], buildTasteProfile(activity()), activity(), [], 'for-you')
    const winner = pool[0]!
    let previousId = pool[1]!.item.id
    const frames = Array.from({ length: 8 }, () => {
      const next = chooseSurpriseAnimationFrame(pool, winner.item.id, previousId, () => 0.5)
      expect(next).toBeDefined()
      expect(next!.item.id).not.toBe(previousId)
      previousId = next!.item.id
      return next!.item.id
    })

    expect(new Set(frames)).toEqual(new Set(pool.map((entry) => entry.item.id)))
  })
  it('strongly favors weekly trends over stale, low-momentum titles in Surprise Me', () => {
    const stale = candidate(111, { year: new Date().getFullYear() - 8 })
    stale.popularity = 0
    const trending = candidate(112, { year: new Date().getFullYear() - 2 })
    trending.popularity = undefined
    trending.source = 'tmdb-trending'
    const profile = buildTasteProfile(activity())
    const ranked = rankCandidates([stale, trending], profile, activity(), [], 'for-you')
    const draws = Array.from({ length: 1000 }, (_, index) => (index + 0.5) / 1000)
    const trendWins = draws.filter((draw) => chooseSurpriseRecommendation(ranked, undefined, () => draw)?.item.tmdbId === 112).length

    expect(trendWins).toBeGreaterThan(750)
  })
  it('prefers a verified weekly trend over a stale title whose score only looks trendy because of popularity', () => {
    const oldPopular = candidate(127, { year: new Date().getFullYear() - 10 })
    oldPopular.popularity = 250
    const weeklyTrend = candidate(128, { year: new Date().getFullYear() - 10 })
    weeklyTrend.popularity = 0
    weeklyTrend.source = 'tmdb-trending'
    const ranked = rankCandidates([oldPopular, weeklyTrend], buildTasteProfile(activity()), activity(), [], 'for-you')
      .sort((left, right) => Number(left.item.tmdbId) - Number(right.item.tmdbId))
    const draws = Array.from({ length: 1000 }, (_, index) => (index + 0.5) / 1000)
    const trendWins = draws.filter((draw) => chooseSurpriseRecommendation(ranked, undefined, () => draw)?.item.tmdbId === 128).length

    expect(trendWins).toBeGreaterThan(600)
  })
  it('ranks weekly-trending titles ahead of equally rated non-trending titles in the normal feed', () => {
    const currentYear = new Date().getFullYear()
    const ordinary = candidate(113, { year: currentYear - 5, rating: 8 })
    ordinary.popularity = 15
    const trending = candidate(114, { year: currentYear - 5, rating: 8 })
    trending.popularity = 15
    trending.source = 'tmdb-trending'
    const ranked = rankCandidates([ordinary, trending], buildTasteProfile(activity()), activity(), [], 'for-you')

    expect(ranked[0]?.item.tmdbId).toBe(114)
  })
  it('lets a verified weekly trend beat a stale low-momentum title in the default feed', () => {
    const archive = candidate(136, { year: new Date().getFullYear() - 12, rating: 8 })
    archive.popularity = 1
    const weeklyTrend = candidate(137, { year: new Date().getFullYear() - 7, rating: 8 })
    weeklyTrend.popularity = 0
    weeklyTrend.source = 'tmdb-trending'
    const ranked = rankCandidates([archive, weeklyTrend], buildTasteProfile(activity()), activity(), [], 'for-you')

    expect(ranked[0]?.item.tmdbId).toBe(137)
  })
  it('does not mistake missing popularity metadata for a hidden gem', () => {
    const year = new Date().getFullYear() - 3
    const established = Array.from({ length: 10 }, (_, index) => {
      const item = candidate(115 + index, { year, rating: 8 })
      item.popularity = 150
      return item
    })
    const unknownPopularity = Array.from({ length: 2 }, (_, index) => {
      const item = candidate(125 + index, { year, rating: 8 })
      item.popularity = undefined
      return item
    })
    const profile = buildTasteProfile(activity())
    const ranked = rankCandidates([...established, ...unknownPopularity], profile, activity(), [], 'for-you')

    expect(ranked.slice(10).every((entry) => !entry.reasons.some((reason) => reason.code === 'hidden-gem'))).toBe(true)
    expect(generateDiscoverySections(ranked, profile, 'for-you', 1).map((section) => section.id)).not.toContain('hidden-gems')
  })
  it('explains when a recommendation is surfaced for its current trend signal', () => {
    const popular = candidate(110)
    popular.popularity = 250
    const result = rankCandidates([popular, candidate(111)], buildTasteProfile(activity()), activity(), [], 'for-you')
    expect(result.find((entry) => entry.item.tmdbId === 110)?.reasons[0]?.label).toBe('Popular right now')
  })
  it('reserves the trending label for candidates from the short-window trending endpoint', () => {
    const trending = candidate(112)
    trending.source = 'tmdb-trending'
    const result = rankCandidates([trending], buildTasteProfile(activity()), activity(), [], 'for-you')
    expect(result[0]?.reasons[0]?.label).toBe('Trending this week')
  })
  it('high ratings are stronger positive signals than low ratings', () => {
    const comedy={...sciFi,id:'comedy',tmdbId:9,genreIds:[35]}
    const profile=buildTasteProfile({progress:[],recent:[],ratings:[{item:sciFi,rating:9},{item:comedy,rating:3}]})
    expect(profile.genreWeights[878]).toBeGreaterThan(profile.genreWeights[35])
  })
  it('rewatches are very strong positive signals',()=>{const profile=buildTasteProfile({progress:[],recent:[],rewatches:[sciFi]});expect(profile.genreWeights[878]).toBeGreaterThan(5)})
  it('learns people and runtime only from optional resolved title metadata',()=>{
    const profile=buildTasteProfile({progress:[],recent:[sciFi],tasteMetadata:[{item:sciFi,runtimeMinutes:51,cast:['Adam Scott'],directors:['Ben Stiller']}]})
    expect(profile.personWeights['Adam Scott']).toBeGreaterThan(0)
    expect(profile.preferredRuntimeMinutes).toBe(51)
    const personMatch={...candidate(9),cast:['Adam Scott'],runtimeMinutes:50}
    expect(rankCandidates([personMatch],profile,activity(),[],'for-you')[0].reasons.map((reason)=>reason.code)).toContain('person-affinity')
  })
  it('filters hidden or disliked titles', () => {
    const item = candidate(2)
    const feedback: RecommendationFeedback[] = [{ mediaKey:mediaKey(item.item),kind:'hide',item:item.item,createdAt:Date.now() }]
    expect(rankCandidates([item],buildTasteProfile(activity()),activity(),feedback,'for-you')).toHaveLength(0)
  })
  it('filters every candidate in a specifically hidden genre', () => {
    const item = candidate(2)
    const feedback: RecommendationFeedback[] = [{ mediaKey:mediaKey(item.item),kind:'hide-genre',genreId:878,item:item.item,createdAt:Date.now() }]
    expect(rankCandidates([item],buildTasteProfile(activity()),activity(),feedback,'for-you')).toHaveLength(0)
  })
  it('applies feedback to a cached snapshot without rebuilding provider results',()=>{
    const profile=buildTasteProfile(activity())
    const first=candidate(2), second=candidate(3,{genreIds:[35]})
    const snapshot=rankCandidates([first,second],profile,activity(),[],'for-you')
    const feedback:RecommendationFeedback[]=[{mediaKey:mediaKey(first.item),kind:'hide',item:first.item,createdAt:Date.now()}]
    expect(applyRecommendationFeedback(snapshot,feedback).map((entry)=>entry.item.tmdbId)).not.toContain(2)
  })
  it('weights recent activity more than older recent activity', () => {
    const other = {...sciFi,id:'older',tmdbId:3,genreIds:[35]}
    const profile = buildTasteProfile(activity([], [sciFi, other]))
    expect(profile.genreWeights[878]).toBeGreaterThan(profile.genreWeights[35])
  })
  it('deduplicates candidates by external media id', () => expect(dedupeCandidates([candidate(2),candidate(2)])).toHaveLength(1))
  it('keeps the strongest popularity and vote signals when merging duplicate provider results', () => {
    const broad = candidate(204)
    broad.popularity = 12
    broad.voteCount = 100
    const trending = candidate(204)
    trending.source = 'tmdb-trending'
    trending.popularity = 240
    trending.voteCount = 9000
    const [merged] = dedupeCandidates([broad, trending])
    expect(merged?.popularity).toBe(240)
    expect(merged?.voteCount).toBe(9000)
  })
  it('preserves explicit trending membership without a popularity number', () => {
    const broad = candidate(205)
    broad.popularity = undefined
    const trending = candidate(205)
    trending.source = 'tmdb-trending'
    trending.popularity = undefined
    const [merged] = dedupeCandidates([broad, trending])
    expect(merged?.trendSignal).toBe(true)
    const ranked = rankCandidates([merged!], buildTasteProfile(activity()), activity(), [], 'for-you')
    expect(ranked[0]?.score.trend).toBeGreaterThanOrEqual(10)
    expect(ranked[0]?.reasons.some((reason) => reason.label === 'Trending this week')).toBe(true)
  })
  it('penalizes already watched titles', () => {
    const watched: WatchProgress = { id:'p',mediaId:'2',tmdbId:2,mediaType:'movie',progressSeconds:100,durationSeconds:100,completed:true }
    expect(rankCandidates([candidate(2),candidate(3)],buildTasteProfile(activity([watched])),activity([watched]),[],'for-you')[0].item.tmdbId).toBe(3)
  })
  it('allows a completed title only when rewatch behavior supports it',()=>{const watched:WatchProgress={id:'p',mediaId:'2',tmdbId:2,mediaType:'movie',progressSeconds:100,durationSeconds:100,completed:true};const item=candidate(2).item;expect(rankCandidates([candidate(2)],buildTasteProfile(activity([watched])),activity([watched]),[],'for-you')).toHaveLength(0);const rewatchActivity={...activity([watched]),rewatches:[item]};expect(rankCandidates([candidate(2)],buildTasteProfile(rewatchActivity),rewatchActivity,[],'for-you')[0].reasons.some((reason)=>reason.code==='rewatch')).toBe(true)})
  it('changes ranking across discovery modes', () => {
    const mainstream = candidate(2); mainstream.popularity=500; mainstream.item.rating=9
    const gem = candidate(3); gem.popularity=4; gem.item.rating=7.5
    const profile=buildTasteProfile(activity())
    expect(rankCandidates([mainstream,gem],profile,activity(),[],'hidden-gems')[0].item.tmdbId).toBe(3)
    expect(rankCandidates([mainstream,gem],profile,activity(),[],'critically-acclaimed')[0].item.tmdbId).toBe(2)
  })
  it('uses distinct eligibility pools for every discovery category',()=>{
    const matching=candidate(10);matching.popularity=300;matching.voteCount=5000;matching.item.rating=9;matching.runtimeMinutes=150;matching.item.year=2020
    const gem=candidate(11,{genreIds:[35],rating:7.8,year:2018});gem.popularity=8;gem.voteCount=400;gem.runtimeMinutes=125
    const recent=candidate(12,{genreIds:[35],rating:7,year:new Date().getFullYear()});recent.popularity=100;recent.voteCount=200;recent.runtimeMinutes=130
    const quick=candidate(13,{genreIds:[35],rating:7,year:2019});quick.popularity=90;quick.voteCount=200;quick.runtimeMinutes=82
    const pool=[matching,gem,recent,quick]
    const profile=buildTasteProfile(activity())
    expect(rankCandidates(pool,profile,activity(),[],'for-you')[0].item.tmdbId).toBe(10)
    expect(rankCandidates(pool,profile,activity(),[],'hidden-gems')[0].item.tmdbId).toBe(11)
    expect(rankCandidates(pool,profile,activity(),[],'recently-released')[0].item.tmdbId).toBe(12)
    expect(rankCandidates(pool,profile,activity(),[],'quick-watch')[0].item.tmdbId).toBe(13)
  })
  it('uses release dates for Recently Released and excludes stale or future titles',()=>{
    const now=Date.UTC(2026,10,2)
    const inWindow=candidate(20,{year:2025,releaseDate:'2025-11-02'})
    const current=candidate(21,{year:2026,releaseDate:'2026-11-01'})
    const yearOnly=candidate(22,{year:2026})
    const stale=candidate(23,{year:2026,releaseDate:'2025-11-01'})
    const future=candidate(24,{year:2027,releaseDate:'2026-11-03'})
    const invalidDate=candidate(25,{year:2025,releaseDate:'2025-02-31'})
    const profile=buildTasteProfile(activity())
    const ranked=rankCandidates([inWindow,current,yearOnly,stale,future,invalidDate],profile,activity(),[],'recently-released',now)
    expect(ranked.map((entry)=>entry.item.tmdbId)).toEqual([21,22,20])
    expect(rankCandidates([stale,future,invalidDate],profile,activity(),[],'recently-released',now)).toEqual([])
  })
  it('builds the general Recently Released shelf from current releases rather than old catalog years',()=>{
    const now=Date.UTC(2026,10,2)
    const profile=buildTasteProfile(activity())
    const general=rankCandidates(Array.from({length:10},(_,index)=>candidate(30+index,{year:2010})),profile,activity(),[],'for-you',now)
    const recentCandidates=[
      candidate(50,{year:2025,releaseDate:'2025-11-02'}),
      candidate(51,{year:2026,releaseDate:'2026-11-01'}),
      candidate(52,{year:2026}),
      candidate(53,{year:2026,releaseDate:'2025-11-01'}),
      candidate(54,{year:2027,releaseDate:'2026-11-03'}),
    ]
    recentCandidates.forEach((entry)=>{entry.popularity=100})
    const recent=rankCandidates(recentCandidates,profile,activity(),[],'for-you',now)
    const section=generateDiscoverySections([...general,...recent],profile,'for-you',1,now).find((entry)=>entry.id==='new')
    expect(section?.items.map((entry)=>entry.item.tmdbId).sort((a,b)=>Number(a || 0)-Number(b || 0))).toEqual([50,51,52])
  })
  it('provides useful fallback ranking for new users and tolerates missing metadata', () => {
    const empty=activity([],[]); const sparse=candidate(4,{genreIds:undefined,rating:undefined,year:undefined})
    expect(rankCandidates([sparse],buildTasteProfile(empty),empty,[],'for-you')[0].reasons[0].code).toBe('exploration')
  })
  it('never emits empty invalid sections', () => expect(generateDiscoverySections(rankCandidates([candidate(2)],buildTasteProfile(activity()),activity(),[],'for-you'),buildTasteProfile(activity()),'for-you',5)).toEqual([]))
  it('does not duplicate a title across generated sections',()=>{const ranked=rankCandidates(Array.from({length:30},(_,index)=>candidate(index+2)),buildTasteProfile(activity()),activity(),[],'for-you');const sections=generateDiscoverySections(ranked,buildTasteProfile(activity()),'for-you',1);const keys=sections.flatMap((section)=>section.items.map((entry)=>mediaKey(entry.item)));expect(new Set(keys).size).toBe(keys.length)})
  it('keeps Discovery to compact, distinct recommendation shelves',()=>{const year=new Date().getFullYear();const pool=Array.from({length:60},(_,index)=>{const item=candidate(index+100,{rating:8,year:index<40?year:2020});item.popularity=index<20?100:10;item.voteCount=500;item.runtimeMinutes=90;return item});const profile=buildTasteProfile(activity());const sections=generateDiscoverySections(rankCandidates(pool,profile,activity(),[],'for-you'),profile,'for-you');expect(sections.length).toBeGreaterThan(1);expect(sections[0].title).toBe('Recommended');expect(sections[0].items.length).toBeLessThanOrEqual(10);expect(sections.map((section)=>section.id)).not.toContain('actors');expect(sections.map((section)=>section.id)).not.toContain('directors');expect(sections.map((section)=>section.id)).not.toContain('critics')})
  it('adds separate favorite shelves and a popularity-ranked shelf for the strongest genre', () => {
    const tasteActivity = activity([], [{ ...sciFi, genreIds: [18] }])
    const profile = buildTasteProfile(tasteActivity)
    const general = Array.from({ length: 20 }, (_, index) => {
      const entry = candidate(700 + index, { genreIds: [18], year: 2020, rating: 7.5 })
      entry.popularity = 220 - index * 4
      return entry
    })
    const similar = Array.from({ length: 3 }, (_, seedIndex) => Array.from({ length: 6 }, (_, index) => {
      const entry = candidate(800 + seedIndex * 10 + index, { genreIds: [18], year: 2020, rating: 7.5 })
      entry.source = 'tmdb-similar'
      entry.seedTitle = `Favorite Seed ${seedIndex + 1}`
      entry.seedKind = 'favorited'
      entry.seedYear = 2019 + seedIndex
      entry.popularity = 140 - index * 10
      return entry
    })).flat()

    const ranked = rankCandidates([...general, ...similar], profile, tasteActivity, [], 'for-you')
    const sections = generateDiscoverySections(ranked, profile, 'for-you')
    const favoriteSections = sections.filter((section) => section.id.startsWith('because-favorited'))
    const genreSection = sections.find((section) => section.id === 'because-genre-18')

    expect(favoriteSections).toHaveLength(3)
    expect(favoriteSections.map((section) => section.title)).toEqual(expect.arrayContaining([
      'Because You Favorited Favorite Seed 1 (2019)',
      'Because You Favorited Favorite Seed 2 (2020)',
      'Because You Favorited Favorite Seed 3 (2021)',
    ]))
    expect(genreSection?.title).toBe('Because You Love Drama')
    expect(genreSection?.items).toHaveLength(10)
    expect(genreSection?.items.map((entry) => entry.popularity)).toEqual([...genreSection!.items.map((entry) => entry.popularity)].sort((left, right) => (right || 0) - (left || 0)))
    const topTenIds = new Set(sections.find((section) => section.id === 'made-for-you')?.items.map((entry) => mediaKey(entry.item)))
    expect(genreSection?.items.every((entry) => !topTenIds.has(mediaKey(entry.item)))).toBe(true)
  })
  it('surfaces weekly trending as its own general catalog shelf without duplicating Recommended',()=>{
    const profile=buildTasteProfile(activity())
    const general=Array.from({length:6},(_,index)=>candidate(300+index))
    const trending=Array.from({length:6},(_,index)=>{const entry=candidate(400+index);entry.source='tmdb-trending';return entry})
    const sections=generateDiscoverySections(rankCandidates([...general,...trending],profile,activity(),[],'for-you'),profile,'for-you')
    const weekly=sections.find((section)=>section.id==='trending-this-week')
    expect(weekly?.title).toBe('Trending This Week')
    expect(weekly?.items).toHaveLength(6)
    expect(sections[0]?.items.every((entry)=>!entry.trendSignal)).toBe(true)
    const keys=sections.flatMap((section)=>section.items.map((entry)=>mediaKey(entry.item)))
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('keeps the weekly trending shelf ordered by public popularity regardless of feed order',()=>{
    const profile=buildTasteProfile(activity())
    const trending=Array.from({length:6},(_,index)=>{const entry=candidate(450+index);entry.source='tmdb-trending';entry.popularity=(index+1)*10;return entry})
    const ranked=rankCandidates(trending,profile,activity(),[],'for-you').reverse()
    const weekly=generateDiscoverySections(ranked,profile,'for-you').find((section)=>section.id==='trending-this-week')
    expect(weekly?.items.map((entry)=>entry.popularity)).toEqual([60,50,40,30,20,10])
  })
  it('keeps the trending shelf compact while preserving the full public feed for Show all', () => {
    const profile = buildTasteProfile(activity([], []))
    const trending = Array.from({ length: 18 }, (_, index) => {
      const entry = candidate(700 + index)
      entry.source = 'tmdb-trending'
      entry.popularity = 200 - index
      return entry
    })
    const weekly = generateDiscoverySections(rankCandidates(trending, profile, activity([], []), [], 'for-you'), profile, 'for-you')
      .find((section) => section.id === 'trending-this-week')

    expect(weekly?.items).toHaveLength(10)
    expect(weekly?.catalogItems).toHaveLength(18)
  })
  it('surfaces a compact Top Rated list only when ratings have enough votes', () => {
    const credible = candidate(690, { rating: 8.1 })
    credible.voteCount = 900
    const higherScoreButThin = candidate(691, { rating: 9.8 })
    higherScoreButThin.voteCount = 32
    const nextBest = candidate(692, { rating: 7.8 })
    nextBest.voteCount = 400
    const profile = buildTasteProfile(activity())
    const ranked = rankCandidates([higherScoreButThin, nextBest, credible], profile, activity(), [], 'for-you')

    expect(selectTopRatedRecommendations(ranked).map((entry) => entry.item.tmdbId)).toEqual([690, 692])
  })
  it('adds a distinct, popularity-aware Top Rated shelf from credible votes', () => {
    const profile = buildTasteProfile(activity([], []))
    const pool = Array.from({ length: 22 }, (_, index) => {
      const entry = candidate(900 + index, { rating: 7.5 + (index % 5) * 0.1, year: 2020 })
      entry.voteCount = 300 + index * 25
      entry.popularity = 220 - index * 3
      return entry
    })
    const sections = generateDiscoverySections(rankCandidates(pool, profile, activity([], []), [], 'for-you'), profile, 'for-you')
    const topTen = sections.find((section) => section.id === 'made-for-you')
    const topRated = sections.find((section) => section.id === 'top-rated')

    expect(topRated?.title).toBe('Top Rated')
    expect(topRated?.items).toHaveLength(10)
    expect(topRated?.catalogItems).toHaveLength(12)
    expect(topRated?.items.map((entry) => entry.item.rating)).toEqual([...topRated!.items.map((entry) => entry.item.rating)].sort((left, right) => (right || 0) - (left || 0)))
    const topTenIds = new Set(topTen?.items.map((entry) => mediaKey(entry.item)))
    expect(topRated?.items.every((entry) => !topTenIds.has(mediaKey(entry.item)))).toBe(true)
  })
  it('keeps a small weekly trend response in Recommended instead of dropping its cards',()=>{
    const profile=buildTasteProfile(activity())
    const general=Array.from({length:2},(_,index)=>candidate(600+index))
    const trending=Array.from({length:3},(_,index)=>{const entry=candidate(610+index);entry.source='tmdb-trending';return entry})
    const sections=generateDiscoverySections(rankCandidates([...general,...trending],profile,activity(),[],'for-you'),profile,'for-you')
    expect(sections[0]?.title).toBe('Recommended')
    expect(sections[0]?.items).toHaveLength(5)
    expect(sections.some((section)=>section.id==='trending-this-week')).toBe(false)
  })
  it('keeps trending membership after catalog and trending results deduplicate',()=>{
    const profile=buildTasteProfile(activity())
    const catalog=candidate(620)
    const weekly=candidate(620)
    weekly.source='tmdb-trending'
    const merged=dedupeCandidates([catalog,weekly])
    const sections=generateDiscoverySections(rankCandidates(merged,profile,activity(),[],'for-you'),profile,'for-you',1)
    expect(sections.find((section)=>section.id==='trending-this-week')?.items.map((entry)=>entry.item.tmdbId)).toEqual([620])
    expect(sections.flatMap((section)=>section.items).filter((entry)=>entry.item.tmdbId===620)).toHaveLength(1)
  })
  it('separates favorited-title similarities from the broad top picks', () => {
    const profile = buildTasteProfile(activity())
    const general = Array.from({ length: 8 }, (_, index) => candidate(400 + index))
    const favorites = Array.from({ length: 6 }, (_, index) => {
      const item = candidate(500 + index)
      item.source = 'tmdb-similar'
      item.seedTitle = 'Severance'
      item.seedKind = 'favorited'
      return item
    })
    const sections = generateDiscoverySections(rankCandidates([...general, ...favorites], profile, activity(), [], 'for-you'), profile, 'for-you')
    expect(sections[0]?.items.every((entry) => entry.source !== 'tmdb-similar')).toBe(true)
    expect(sections.find((section) => section.id === 'because-favorited')?.title).toBe('Because You Favorited Severance')
    expect(sections.find((section) => section.id === 'because-watched')).toBeUndefined()
  })
  it('gradually penalizes repeatedly shown and ignored recommendations',()=>{const profile=buildTasteProfile(activity());const fresh=rankCandidates([candidate(2)],profile,activity(),[],'for-you',Date.now(),{})[0];const ignored=rankCandidates([candidate(2)],profile,activity(),[],'for-you',Date.now(),{[mediaKey(candidate(2).item)]:10})[0];expect(ignored.score.total).toBeLessThan(fresh.score.total)})
})
