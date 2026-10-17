import { describe, expect, it } from 'vitest'
import { getBerlinDateKey, getNextBerlinMidnight } from './berlinDate'

describe('Berlin discovery day', () => {
  it('uses the Berlin calendar day across CET midnight', () => {
    expect(getBerlinDateKey(new Date('2026-01-10T22:59:59.000Z'))).toBe('2026-01-10')
    expect(getBerlinDateKey(new Date('2026-01-10T23:00:00.000Z'))).toBe('2026-01-11')
  })

  it('uses the Berlin calendar day across CEST midnight', () => {
    expect(getBerlinDateKey(new Date('2026-07-10T21:59:59.000Z'))).toBe('2026-07-10')
    expect(getBerlinDateKey(new Date('2026-07-10T22:00:00.000Z'))).toBe('2026-07-11')
  })

  it('finds the next Berlin midnight through the DST spring transition', () => {
    expect(getNextBerlinMidnight(new Date('2026-03-29T20:00:00.000Z')).toISOString()).toBe('2026-03-29T22:00:00.000Z')
  })
})
