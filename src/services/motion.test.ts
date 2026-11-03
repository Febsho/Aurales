import { describe, expect, it } from 'vitest'
import { preferredScrollBehavior } from './motion'

describe('preferred scroll behavior', () => {
  it('keeps smooth scrolling when motion is allowed', () => {
    expect(preferredScrollBehavior(false)).toBe('smooth')
  })

  it('avoids animated scrolling when reduced motion is requested', () => {
    expect(preferredScrollBehavior(true)).toBe('auto')
  })
})
