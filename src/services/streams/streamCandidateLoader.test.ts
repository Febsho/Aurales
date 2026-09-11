import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { loadStreamCandidatesNative } from './streamCandidateLoader'

const addon = (id: string) => ({
  enabled: true,
  url: `https://${id}.example/manifest.json`,
  manifest: { id, name: id, version: '1', description: '', resources: ['stream'], types: ['movie'], catalogs: [] },
})

describe('native stream candidate loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  })

  it('sends one coarse request and preserves decorated candidates and failures', async () => {
    const candidate = { title: 'Movie 1080p', url: 'https://cdn.example/v.mp4', addonId: 'one', addonName: 'one' }
    invokeMock.mockResolvedValue({ candidates: [candidate], failures: [{ addonId: 'two', addonName: 'two', error: 'offline' }], stale: false })
    await expect(loadStreamCandidatesNative('movie', 'tt1', [addon('one'), addon('two')], { cancelGroup: 'play' }))
      .resolves.toEqual({ candidates: [candidate], failures: [{ addonId: 'two', addonName: 'two', error: 'offline' }] })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('rejects stale native work without converting it to an empty result', async () => {
    invokeMock.mockResolvedValue({ candidates: [], failures: [], stale: true })
    await expect(loadStreamCandidatesNative('movie', 'tt1', [addon('one')], { cancelGroup: 'play' }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
