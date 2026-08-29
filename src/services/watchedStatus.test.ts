import { describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  })
  return values
})

import { batchIsWatchedFromProviders } from './watchedStatus'

describe('episode watched status', () => {
  const episode = (episodeNumber: number) => ({
    id: 'show-1',
    type: 'series' as const,
    imdbId: 'tt123',
    season: 1,
    episode: episodeNumber,
  })

  it('does not turn a completed show-level local record into every episode', async () => {
    const watched = await batchIsWatchedFromProviders(
      [episode(1), episode(2)],
      ['local'],
      new Set(['show-1']),
    )

    expect(watched).toEqual(new Set())
  })

  it('keeps exact local episode completion working', async () => {
    const watched = await batchIsWatchedFromProviders(
      [episode(1), episode(2)],
      ['local'],
      new Set(['show-1:1:2']),
    )

    expect(watched).toEqual(new Set(['1:2']))
  })
})
