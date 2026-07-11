import { describe, expect, it } from 'vitest'
import type { SearchResult, WatchProgress } from '../../types'
import { buildTasteProfile, dedupeCandidates, generateDiscoverySections, mediaKey, rankCandidates } from './recommendationEngine'
import type { DiscoveryActivity, RecommendationCandidate, RecommendationFeedback } from './types'

const sciFi: SearchResult = { id:'seed',title:'Seed',type:'movie',provider:'tmdb',tmdbId:1,genreIds:[878],year:2020,rating:8 }
const activity = (progress: WatchProgress[] = [], recent: SearchResult[] = [sciFi]): DiscoveryActivity => ({ progress, recent })
const candidate = (id:number, overrides:Partial<SearchResult> = {}): RecommendationCandidate => ({ item:{ id:`tmdb-${id}`,title:`Title ${id}`,type:'movie',provider:'tmdb',tmdbId:id,genreIds:[878],rating:8,year:2025,poster:`poster-${id}.jpg`,...overrides },source:'tmdb-discover',voteCount:1000,popularity:20,runtimeMinutes:95 })

describe('discovery recommendation engine', () => {
  it('completed titles strengthen matching preferences', () => {
    const completed: WatchProgress = { id:'p',mediaId:'seed',mediaType:'movie',progressSeconds:100,durationSeconds:100,completed:true }
    expect(buildTasteProfile(activity([completed])).genreWeights[878]).toBeGreaterThan(buildTasteProfile(activity()).genreWeights[878])
  })
  it('high ratings are stronger positive signals than low ratings', () => {
    const comedy={...sciFi,id:'comedy',tmdbId:9,genreIds:[35]}
    const profile=buildTasteProfile({progress:[],recent:[],ratings:[{item:sciFi,rating:9},{item:comedy,rating:3}]})
    expect(profile.genreWeights[878]).toBeGreaterThan(profile.genreWeights[35])
  })
  it('rewatches are very strong positive signals',()=>{const profile=buildTasteProfile({progress:[],recent:[],rewatches:[sciFi]});expect(profile.genreWeights[878]).toBeGreaterThan(5)})
  it('filters hidden or disliked titles', () => {
    const item = candidate(2)
    const feedback: RecommendationFeedback[] = [{ mediaKey:mediaKey(item.item),kind:'hide',item:item.item,createdAt:Date.now() }]
    expect(rankCandidates([item],buildTasteProfile(activity()),activity(),feedback,'for-you')).toHaveLength(0)
  })
  it('weights recent activity more than older recent activity', () => {
    const other = {...sciFi,id:'older',tmdbId:3,genreIds:[35]}
    const profile = buildTasteProfile(activity([], [sciFi, other]))
    expect(profile.genreWeights[878]).toBeGreaterThan(profile.genreWeights[35])
  })
  it('deduplicates candidates by external media id', () => expect(dedupeCandidates([candidate(2),candidate(2)])).toHaveLength(1))
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
  it('provides useful fallback ranking for new users and tolerates missing metadata', () => {
    const empty=activity([],[]); const sparse=candidate(4,{genreIds:undefined,rating:undefined,year:undefined})
    expect(rankCandidates([sparse],buildTasteProfile(empty),empty,[],'for-you')[0].reasons[0].code).toBe('exploration')
  })
  it('never emits empty invalid sections', () => expect(generateDiscoverySections(rankCandidates([candidate(2)],buildTasteProfile(activity()),activity(),[],'for-you'),buildTasteProfile(activity()),'for-you',5)).toEqual([]))
  it('does not duplicate a title across generated sections',()=>{const ranked=rankCandidates(Array.from({length:30},(_,index)=>candidate(index+2)),buildTasteProfile(activity()),activity(),[],'for-you');const sections=generateDiscoverySections(ranked,buildTasteProfile(activity()),'for-you',1);const keys=sections.flatMap((section)=>section.items.map((entry)=>mediaKey(entry.item)));expect(new Set(keys).size).toBe(keys.length)})
  it('does not let the first catalog consume the full recommendation pool',()=>{const year=new Date().getFullYear();const pool=Array.from({length:60},(_,index)=>{const item=candidate(index+100,{rating:8,year:index<40?year:2020});item.popularity=index<20?100:10;item.voteCount=500;item.runtimeMinutes=90;return item});const profile=buildTasteProfile(activity());const sections=generateDiscoverySections(rankCandidates(pool,profile,activity(),[],'for-you'),profile,'for-you');expect(sections.length).toBeGreaterThan(1);expect(sections[0].items.length).toBeLessThanOrEqual(20)})
  it('gradually penalizes repeatedly shown and ignored recommendations',()=>{const profile=buildTasteProfile(activity());const fresh=rankCandidates([candidate(2)],profile,activity(),[],'for-you',Date.now(),{})[0];const ignored=rankCandidates([candidate(2)],profile,activity(),[],'for-you',Date.now(),{[mediaKey(candidate(2).item)]:10})[0];expect(ignored.score.total).toBeLessThan(fresh.score.total)})
})
