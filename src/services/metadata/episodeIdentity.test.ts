import { expect, it } from 'vitest'
import { matchingEpisode } from './episodeIdentity'
const episode = { id: 'tvdb-1', seasonNumber: 2, episodeNumber: 1, name: 'Episode', airDate: '2020-01-01' }
it('matches an episode moved into a different TMDB season', () => {
  const candidate = { ...episode, id: 'tmdb-25', seasonNumber: 1, episodeNumber: 25 }
  expect(matchingEpisode(episode, [candidate])).toBe(candidate)
})
it('rejects identical numbering with different release dates', () => {
  expect(matchingEpisode(episode, [{ ...episode, airDate: '2021-01-01' }])).toBeUndefined()
})
it('rejects missing dates and ambiguous batch releases', () => {
  expect(matchingEpisode({ ...episode, airDate: undefined }, [episode])).toBeUndefined()
  expect(matchingEpisode(episode, [episode, { ...episode, id: '2' }])).toBeUndefined()
})
it('accepts an explicit external ID even if dates differ', () => {
  const candidate = { ...episode, imdbId: 'tt1', airDate: '2021-01-01' }
  expect(matchingEpisode({ ...episode, imdbId: 'tt1' }, [candidate])).toBe(candidate)
})
