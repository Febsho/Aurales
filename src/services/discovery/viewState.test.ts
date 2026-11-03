import { describe, expect, it } from 'vitest'
import { discoveryViewState } from './viewState'

describe('Discovery page states', () => {
  it('shows skeletons before an uncached load settles', () => expect(discoveryViewState(0, false)).toBe('loading'))
  it('shows cached content immediately', () => expect(discoveryViewState(8, false)).toBe('content'))
  it('shows public weekly trends when broad catalog requests have no results', () => expect(discoveryViewState(0, false, 6)).toBe('content'))
  it('shows an error only after an empty load settles', () => expect(discoveryViewState(0, true)).toBe('error'))
})
