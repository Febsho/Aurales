import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessionViewState,
  getRouteScroll,
  getShelfView,
  rememberRouteScroll,
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
})
