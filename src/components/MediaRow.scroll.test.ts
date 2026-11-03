import { describe, expect, it } from 'vitest'
// @ts-expect-error node:fs is available in the test runtime.
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./MediaRow.tsx', import.meta.url), 'utf8')

describe('MediaRow horizontal scrolling', () => {
  it('moves between rendered card starts and clamps at the measured rail bounds', () => {
    expect(source).toContain('const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)')
    expect(source).toContain('const cardTargets = cards.map((card) => Math.max(0, Math.min(maxScroll,')
    expect(source).toContain('getMediaRowScrollTarget({ cardStarts: cardTargets, current, maxScroll, direction, cardsPerPage })')
    expect(source).toContain('card.getBoundingClientRect().left - trackRect.left - startInset')
    expect(source).toContain("element.scrollTo({ left: target, behavior: 'smooth' })")
    expect(source).toContain("':scope > .media-row-card-slot > button'")
    expect(source).not.toContain('Math.max(640, Math.floor(scrollRef.current.clientWidth')
  })

  it('uses the shelf heading as the full-catalog entry without an extra Show all poster', () => {
    expect(source).toContain('onClick={openShowAll}')
    expect(source).toContain('aria-label={`Open ${title} catalog`}')
    expect(source).toContain('text-white/45')
    expect(source).not.toContain('data-show-all-layout')
    expect(source).not.toContain('show-all-card')
  })

  it('smoothly maps Shift+wheel input onto the poster rail', () => {
    expect(source).toContain('const handleRowWheel')
    expect(source).toContain('if (!event.shiftKey) return')
    expect(source).toContain('onWheel={handleRowWheel}')
    expect(source).toContain("scrollBy({ left: amount, behavior: 'smooth' })")
  })
})
