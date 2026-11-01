import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { deleteSyncPassword, loadSyncPassword, saveSyncPassword, syncPasswordPersistenceAvailable } from './secureLogin'

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => vi.clearAllMocks())

describe('sync password persistence adapter', () => {
  it('does not persist the account password in browser storage', async () => {
    vi.stubGlobal('window', {})

    expect(syncPasswordPersistenceAvailable()).toBe(false)
    await saveSyncPassword('user@example.test', 'long password')
    await expect(loadSyncPassword('user@example.test')).resolves.toBeNull()
    await deleteSyncPassword('user@example.test')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('uses the native secure store when the Tauri bridge exists', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce('secret').mockResolvedValueOnce(undefined)

    expect(syncPasswordPersistenceAvailable()).toBe(true)
    await saveSyncPassword('user@example.test', 'long password')
    await expect(loadSyncPassword('user@example.test')).resolves.toBe('secret')
    await deleteSyncPassword('user@example.test')
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'sync_password_store', 'sync_password_load', 'sync_password_delete',
    ])
  })
})
