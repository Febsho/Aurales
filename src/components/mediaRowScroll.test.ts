import { describe, expect, it } from 'vitest'
import { getMediaRowScrollTarget } from './mediaRowScroll'

describe('MediaRow scroll targets', () => {
  it('uses a predictable two-card step without skipping content on wide layouts', () => {
    const cardStarts = [0, 100, 200, 300, 400, 500, 600, 700]
    expect(getMediaRowScrollTarget({ cardStarts, current: 0, maxScroll: 730, direction: 'right', cardsPerPage: 3 })).toBe(200)
    expect(getMediaRowScrollTarget({ cardStarts, current: 0, maxScroll: 730, direction: 'right', cardsPerPage: 6 })).toBe(200)
  })

  it('clamps the final stop to actual content and returns to the real start', () => {
    expect(getMediaRowScrollTarget({ cardStarts: [0, 120, 240, 360], current: 240, maxScroll: 275, direction: 'right', cardsPerPage: 3 })).toBe(275)
    expect(getMediaRowScrollTarget({ cardStarts: [0, 120, 240, 360], current: 275, maxScroll: 275, direction: 'left', cardsPerPage: 3 })).toBe(120)
    expect(getMediaRowScrollTarget({ cardStarts: [0, 120], current: 0, maxScroll: 0, direction: 'right', cardsPerPage: 3 })).toBe(0)
  })

  it('handles sparse and invalid card measurements without producing an out-of-range target', () => {
    const target = getMediaRowScrollTarget({ cardStarts: [Number.NaN, -50, 10_000], current: 0, maxScroll: 90, direction: 'right', cardsPerPage: 2 })
    expect(target).toBe(90)
    expect(target).toBeGreaterThanOrEqual(0)
    expect(target).toBeLessThanOrEqual(90)
  })
})
