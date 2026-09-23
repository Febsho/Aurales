import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessionViewState,
  getDetailView,
  getRouteScroll,
  getShelfView,
  rememberRouteScroll,
  rememberDetailView,
  rememberShelfView,
  routeViewKey,
} from './sessionViewState'

describe('session view state', () => {
  beforeEach(clearSessionViewState)

  it('restores a catalog page independently from its detail route', () => {
    const home = routeViewKey('/', '')
    const details = routeViewKey('/movie/123', '?provider=tmdb')
    rememberRouteScroll(home, 1840)
    rememberRouteScroll(details, 220)

    expect(getRouteScroll(home)).toBe(1840)
    expect(getRouteScroll(details)).toBe(220)
  })

  it('retains horizontal position and the progressively rendered card count', () => {
    rememberShelfView('/:popular:poster', { scrollLeft: 960, renderedCount: 24 })
    expect(getShelfView('/:popular:poster')).toEqual({ scrollLeft: 960, renderedCount: 24 })
  })

  it('normalizes invalid negative offsets', () => {
    rememberRouteScroll('/', -20)
    rememberShelfView('row', { scrollLeft: -12, renderedCount: 0 })
    expect(getRouteScroll('/')).toBe(0)
    expect(getShelfView('row')).toEqual({ scrollLeft: 0, renderedCount: 1 })
  })

  it('keeps detail navigation state in the existing bounded session store', () => {
    rememberDetailView('series:7', {
      selectedSeason: 2,
      focusedTarget: 'episode:2:4',
      expandedOverview: true,
      episodeScrollLeft: 840,
      renderedEpisodeCount: 16,
    })
    rememberDetailView('series:7', { episodeScrollLeft: 920 })

    expect(getDetailView('series:7')).toEqual({
      selectedSeason: 2,
      focusedTarget: 'episode:2:4',
      expandedOverview: true,
      episodeScrollLeft: 920,
      renderedEpisodeCount: 16,
    })
  })
})
