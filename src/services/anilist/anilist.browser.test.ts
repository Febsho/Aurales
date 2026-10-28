import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../../platform/capabilities', () => ({
  getPlatformCapabilities: () => ({ platform: 'web' }),
}))

import { anilistRequest, setAniListToken } from '../anilist'

describe('AniList browser transport', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'anilist_token' ? 'browser-token' : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    setAniListToken('browser-token')
    invokeMock.mockClear()
  })

  it('does not attempt Tauri IPC after a browser network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await expect(anilistRequest('query { Viewer { id } }')).rejects.toThrow(
      'Could not reach AniList from this browser. Check your connection and try again.',
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
