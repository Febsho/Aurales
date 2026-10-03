import { beforeEach, describe, expect, it, vi } from 'vitest'

const { simklRequest, normalizeSimklHistoryItems, invoke, isTauri } = vi.hoisted(() => ({
  simklRequest: vi.fn(),
  normalizeSimklHistoryItems: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri }))
vi.mock('./auth', () => ({ isSimklMockMode: () => false, getStoredSimklAccount: () => ({ id: 'account-1' }) }))
vi.mock('./client', () => ({ simklRequest }))
vi.mock('./history', () => ({ normalizeSimklHistoryItems }))
vi.mock('./lists', () => ({ addToSimklWatchlist: vi.fn() }))

import { getSyncedSimklItems, pullSimklLists } from './sync'

function storage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  }
}

describe('SIMKL v2 sync migration', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    simklRequest.mockReset()
    normalizeSimklHistoryItems.mockClear()
    invoke.mockReset()
    isTauri.mockReturnValue(false)
  })

  it('bootstraps shows, movies, and anime sequentially before saving activities', async () => {
    simklRequest
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ all: '2026-09-19T10:00:00Z' })

    await expect(pullSimklLists()).resolves.toEqual({ pulled: 0, errors: [] })
    expect(simklRequest.mock.calls.map(([path]) => path)).toEqual([
      '/sync/all-items/shows?extended=full&episode_watched_at=yes&include_all_episodes=yes',
      '/sync/all-items/movies?extended=full&episode_watched_at=yes&include_all_episodes=yes',
      '/sync/all-items/anime?extended=full&episode_watched_at=yes&include_all_episodes=yes',
      '/sync/activities',
    ])
    expect(JSON.parse(localStorage.getItem('simkl_sync_state_v2')!)).toEqual({ activitiesAll: '2026-09-19T10:00:00Z' })
  })

  it('uses activities as the delta gate and preserves the opaque cursor exactly', async () => {
    localStorage.setItem('simkl_sync_state_v2', JSON.stringify({ activitiesAll: '2026-09-19T10:00:00Z' }))
    simklRequest.mockResolvedValueOnce({ all: '2026-09-19T10:00:00Z' })

    await expect(pullSimklLists()).resolves.toEqual({ pulled: 0, errors: [] })
    expect(simklRequest).toHaveBeenCalledTimes(1)

    simklRequest.mockReset()
    simklRequest.mockResolvedValueOnce({ all: '2026-09-19T10:05:00Z' }).mockResolvedValueOnce([])
    await pullSimklLists()
    expect(simklRequest.mock.calls.map(([path]) => path)).toEqual([
      '/sync/activities',
      '/sync/all-items?date_from=2026-09-19T10%3A00%3A00Z&extended=full&episode_watched_at=yes&include_all_episodes=yes',
    ])
  })

  it('migrates a full localStorage library to SQLite before merging a SIMKL delta', async () => {
    const legacy = [{ id: '1', type: 'show', title: 'Saved show', status: 'completed' }]
    const backing = storage()
    backing.setItem('simkl_local_watchlist', JSON.stringify(legacy))
    backing.setItem('simkl_sync_state_v2', JSON.stringify({ activitiesAll: '2026-09-19T10:00:00Z' }))
    vi.stubGlobal('localStorage', {
      ...backing,
      setItem: (key: string, value: string) => {
        if (key === 'simkl_local_watchlist') throw new Error('The quota has been exceeded.')
        backing.setItem(key, value)
      },
    })
    isTauri.mockReturnValue(true)
    const entries = new Map<string, string>()
    invoke.mockImplementation(async (command: string, args: { key: string; value?: string }) => {
      if (command === 'cache_entry_get') return entries.has(args.key) ? { value: entries.get(args.key) } : null
      if (command === 'cache_entry_set') { entries.set(args.key, args.value!); return null }
      throw new Error(`Unexpected command: ${command}`)
    })
    simklRequest.mockResolvedValueOnce({ all: '2026-09-19T10:05:00Z' })
      .mockResolvedValueOnce([{ id: '2', type: 'show', title: 'New show', status: 'completed' }])

    await expect(pullSimklLists()).resolves.toEqual({ pulled: 1, errors: [] })
    const snapshot = JSON.parse([...entries.values()][0])
    expect(snapshot).toMatchObject({ activitiesAll: '2026-09-19T10:05:00Z' })
    expect(snapshot.items.map((item: { id: string }) => item.id)).toEqual(['1', '2'])
    expect(backing.getItem('simkl_local_watchlist')).toBeNull()
    expect(backing.getItem('simkl_sync_state_v2')).toBeNull()
  })

  it('keeps the legacy library if the SQLite migration fails', async () => {
    const backing = storage()
    backing.setItem('simkl_local_watchlist', JSON.stringify([{ id: '1', type: 'show', title: 'Saved show', status: 'completed' }]))
    vi.stubGlobal('localStorage', backing)
    isTauri.mockReturnValue(true)
    invoke.mockImplementation(async (command: string) => {
      if (command === 'cache_entry_get') return null
      throw new Error('SQLite write failed')
    })

    await expect(pullSimklLists()).resolves.toEqual({ pulled: 0, errors: ['library: SQLite write failed'] })
    expect(backing.getItem('simkl_local_watchlist')).not.toBeNull()
    expect(simklRequest).not.toHaveBeenCalled()
  })

  it('finishes an interrupted migration without dropping legacy items', async () => {
    const backing = storage()
    backing.setItem('simkl_local_watchlist', JSON.stringify([{ id: '2', type: 'movie', title: 'Legacy movie', status: 'completed' }]))
    vi.stubGlobal('localStorage', backing)
    isTauri.mockReturnValue(true)
    const entries = new Map([[
      'simkl_sync_snapshot:v2:default:account-1',
      JSON.stringify({ items: [{ id: '1', type: 'show', title: 'Native show', status: 'completed' }], activitiesAll: 'cursor' }),
    ]])
    invoke.mockImplementation(async (command: string, args: { key: string; value?: string }) => {
      if (command === 'cache_entry_get') return entries.has(args.key) ? { value: entries.get(args.key) } : null
      if (command === 'cache_entry_set') { entries.set(args.key, args.value!); return null }
      throw new Error(`Unexpected command: ${command}`)
    })

    expect((await getSyncedSimklItems()).map((item) => item.id)).toEqual(['2', '1'])
    expect(backing.getItem('simkl_local_watchlist')).toBeNull()
    expect(JSON.parse([...entries.values()][0]).items).toHaveLength(2)
  })
})
