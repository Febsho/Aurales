import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionViewState,
  flushSessionViewState,
  getDetailView,
  getHomeShelfId,
  getRouteScroll,
  getShelfView,
  rememberRouteScroll,
  rememberDetailView,
  rememberHomeShelfId,
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

  it('persists positions separately for each profile across switches', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    values.set('aurales_active_profile_v1', 'alice')
    rememberRouteScroll('/', 420)
    rememberHomeShelfId('continue')
    flushSessionViewState()
    values.set('aurales_active_profile_v1', 'bob')
    expect(getRouteScroll('/')).toBeUndefined()
    rememberRouteScroll('/', 30)
    values.set('aurales_active_profile_v1', 'alice')
    expect(getRouteScroll('/')).toBe(420)
    expect(getHomeShelfId()).toBe('continue')
    vi.unstubAllGlobals()
  })
})
