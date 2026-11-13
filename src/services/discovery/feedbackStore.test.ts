import { beforeEach,describe,expect,it,vi } from 'vitest'
import { loadRecommendationFeedback,resetTasteFeedback,saveRecommendationFeedback,unhideRecommendationGenre } from './feedbackStore'

describe('recommendation feedback persistence',()=>{beforeEach(()=>{const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value)});vi.stubGlobal('window',{dispatchEvent:vi.fn()});});it('persists hidden titles across reloads',()=>{saveRecommendationFeedback({id:'x',title:'Hidden',type:'movie',provider:'tmdb',tmdbId:7},'hide');expect(loadRecommendationFeedback()).toMatchObject([{kind:'hide',mediaKey:'movie:tmdb:7'}])});it('replaces earlier feedback for the same title',()=>{const item={id:'x',title:'Title',type:'movie' as const,provider:'tmdb',tmdbId:7};saveRecommendationFeedback(item,'less-like-this');saveRecommendationFeedback(item,'more-like-this');expect(loadRecommendationFeedback()).toHaveLength(1);expect(loadRecommendationFeedback()[0].kind).toBe('more-like-this')});it('keeps separately selected hidden genres from one title',()=>{const item={id:'x',title:'Title',type:'movie' as const,provider:'tmdb',tmdbId:7,genreIds:[878,18]};saveRecommendationFeedback(item,'hide-genre',878);saveRecommendationFeedback(item,'hide-genre',18);expect(loadRecommendationFeedback()).toMatchObject([{kind:'hide-genre',genreId:18},{kind:'hide-genre',genreId:878}])});it('can restore one hidden genre without restoring the others',()=>{const item={id:'x',title:'Title',type:'movie' as const,provider:'tmdb',tmdbId:7,genreIds:[878,18]};saveRecommendationFeedback(item,'hide-genre',878);saveRecommendationFeedback(item,'hide-genre',18);unhideRecommendationGenre(878);expect(loadRecommendationFeedback()).toMatchObject([{kind:'hide-genre',genreId:18}])})})

it('preserves anime IDs and taste context so saved choices can be matched and ranked',()=>{
  const values=new Map<string,string>()
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value)})
  vi.stubGlobal('window',{dispatchEvent:vi.fn()})
  const item={id:'anilist-88',title:'Anime pick',type:'series' as const,provider:'anilist',anilistId:88,malId:19,genreIds:[16,14],overview:'A magical adventure',originalLanguage:'ja'}
  saveRecommendationFeedback(item,'more-like-this')
  expect(loadRecommendationFeedback()[0]).toMatchObject({mediaKey:'series:anilist:88',item:{anilistId:88,malId:19,provider:'anilist',overview:'A magical adventure',originalLanguage:'ja'}})
})

it('resets a saved taste pick using its persisted identity even when it is no longer in the active catalog',()=>{
  const values=new Map<string,string>()
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value)})
  vi.stubGlobal('window',{dispatchEvent:vi.fn()})
  const item={id:'anilist-88',title:'Anime pick',type:'series' as const,provider:'anilist',anilistId:88,genreIds:[16]}
  saveRecommendationFeedback(item,'more-like-this')
  saveRecommendationFeedback({id:'other',title:'Other',type:'series',provider:'tmdb',tmdbId:9},'hide')
  resetTasteFeedback([],['series:anilist:88'])
  expect(loadRecommendationFeedback()).toMatchObject([{kind:'hide',mediaKey:'series:tmdb:9'}])
})

it('resets taste-picker likes while preserving unrelated feedback',()=>{
  const values=new Map<string,string>()
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value)})
  vi.stubGlobal('window',{dispatchEvent:vi.fn()})
  const selected={id:'selected',title:'Selected',type:'movie' as const,provider:'tmdb',tmdbId:11}
  const hidden={id:'hidden',title:'Hidden',type:'movie' as const,provider:'tmdb',tmdbId:12}
  saveRecommendationFeedback(selected,'more-like-this')
  saveRecommendationFeedback(hidden,'hide')
  resetTasteFeedback([selected])
  expect(loadRecommendationFeedback()).toMatchObject([{kind:'hide',mediaKey:'movie:tmdb:12'}])
})
