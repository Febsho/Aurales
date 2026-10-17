import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStremioLibrary, getStremioWatchHistory } from './stremio'

afterEach(() => vi.restoreAllMocks())

function mockLibrary(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: items }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })))
}

describe('Stremio library import', () => {
  it('keeps watchlist, watched and continue-watching as separate states', async () => {
    mockLibrary([
      {
        _id: 'tt100', name: 'Saved only', type: 'movie', removed: false, temp: false,
        state: { timeOffset: 0, duration: 0, timesWatched: 0 },
      },
      {
        _id: 'tt200', name: 'Half watched', type: 'movie', removed: true, temp: true,
        state: { timeOffset: 600_000, duration: 1_200_000, timesWatched: 0 },
      },
      {
        _id: 'tt300', name: 'Finished', type: 'movie', removed: false, temp: false,
        state: { timeOffset: 0, duration: 7_200_000, timesWatched: 1 },
      },
    ])

    const entries = await getStremioLibrary('key')
    expect(entries[0]).toMatchObject({ inLibrary: true, watched: false, continueWatching: false })
    expect(entries[1]).toMatchObject({ inLibrary: false, watched: false, continueWatching: true, progressSeconds: 600, durationSeconds: 1200 })
    expect(entries[2]).toMatchObject({ inLibrary: true, watched: true, continueWatching: false, watchedCount: 1 })
  })

  it('uses the state video id for episode resume and does not call started items watched', async () => {
    mockLibrary([{
      d: {
        _id: 'tt400', name: 'A show', type: 'series', removed: false, temp: false,
        state: { video_id: 'tt400:3:7', timeOffset: 42_000, duration: 2_400_000, timesWatched: 0 },
      },
    }])

    const [entry] = await getStremioLibrary('key')
    expect(entry).toMatchObject({ id: 'tt400', season: 3, episode: 7, watched: false, continueWatching: true })
    expect(await getStremioWatchHistory('key')).toEqual([])
  })

  it('decodes Stremio watched episode bitfields against Cinemeta video order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('cinemeta')
        ? { meta: { videos: Array.from({ length: 9 }, (_, index) => ({ id: `tt2934286:1:${index + 1}`, season: 1, episode: index + 1 })) } }
        : { result: [{
          _id: 'tt2934286', name: 'A show', type: 'series', removed: false, temp: false,
          state: { timesWatched: 5, watched: 'tt2934286:1:5:5:eJyTZwAAAEAAIA==' },
        }] }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }))

    const [entry] = await getStremioLibrary('key', true)
    expect(entry.watchedEpisodeIds).toEqual(Array.from({ length: 5 }, (_, index) => `tt2934286:1:${index + 1}`))
  })
})
