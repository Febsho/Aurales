import { describe, expect, it } from 'vitest'
// @ts-expect-error node:fs is available in the test runtime.
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./MediaRow.tsx', import.meta.url), 'utf8')

describe('MediaRow horizontal scrolling', () => {
  it('smoothly maps Shift+wheel input onto the poster rail', () => {
    expect(source).toContain('const handleRowWheel')
    expect(source).toContain('if (!event.shiftKey) return')
    expect(source).toContain('onWheel={handleRowWheel}')
    expect(source).toContain("scrollBy({ left: amount, behavior: 'smooth' })")
  })
})
