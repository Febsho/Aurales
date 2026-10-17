import { describe, expect, it } from 'vitest'
import { continueWatchingVisibility } from './continueWatchingPolicy'

const base = { id: 'x', mediaId: 'x', mediaType: 'movie', progressSeconds: 300, durationSeconds: 7200, completed: false, updatedAt: new Date().toISOString() }
describe('Continue Watching cleanup policy', () => {
  it('hides an old accidental start but preserves meaningful progress', () => {
    expect(continueWatchingVisibility({ ...base, progressSeconds: 60, updatedAt: new Date(Date.now() - 2 * 86400000).toISOString() }).visible).toBe(false)
    expect(continueWatchingVisibility({ ...base, progressSeconds: 1800, updatedAt: new Date(Date.now() - 60 * 86400000).toISOString() }).visible).toBe(true)
  })
  it('hides completed items with the central threshold', () => { expect(continueWatchingVisibility({ ...base, progressSeconds: 6500 }).reason).toBe('completed') })
})
