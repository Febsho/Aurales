import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runSyncBatchMock } = vi.hoisted(() => ({ runSyncBatchMock: vi.fn() }))
vi.mock('./syncBatch', () => ({ runSyncBatch: runSyncBatchMock }))
vi.mock('./outbox', () => ({ outboxReady: vi.fn(async () => undefined), removeOutboxRecords: vi.fn(), takeOutboxBatch: vi.fn(() => []) }))
vi.mock('./encryptedVault', () => ({ acknowledgeEncryptedVault: vi.fn(), isSyncVaultUnlocked: vi.fn(() => false), restoreEncryptedVault: vi.fn() }))
vi.mock('./syncQueue', () => ({
  AURALES_SYNC_SCHEMA_VERSION: 1,
  enqueueSyncRecord: vi.fn(),
  enqueueSyncRecords: vi.fn(),
  getDeviceId: vi.fn(() => 'test-device'),
  getSyncOutbox: vi.fn(() => []),
  scheduleAutomaticSync: vi.fn(),
}))
vi.mock('../profiles', () => ({
  applySyncedProfile: vi.fn(),
  clearPendingProfileDeletions: vi.fn(),
  getActiveProfileId: vi.fn(() => 'active-profile'),
  getPendingProfileDeletions: vi.fn(() => []),
  getProfiles: vi.fn(() => []),
  profileStorageKey: (key: string, profileId: string) => `${key}:profile:${profileId}`,
}))
vi.mock('../watchlistIdentity', () => ({ sameWatchlistItem: vi.fn(), watchlistIdentity: vi.fn() }))
vi.mock('../../platform/capabilities', () => ({ shouldReloadAfterVaultRestore: vi.fn(() => false) }))

import { downloadSyncNow, getSyncConfig, syncIfConfigured } from './auralesSync'
import { scheduleAutomaticSync } from './syncQueue'

const storageValues = new Map<string, string>()
const storage = {
  get length() { return storageValues.size },
  key: (index: number) => [...storageValues.keys()][index] ?? null,
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storageValues.set(key, String(value)) },
  removeItem: (key: string) => { storageValues.delete(key) },
  clear: () => storageValues.clear(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', storage)
  storage.clear()
  storage.setItem('aurales_sync_config_v1', JSON.stringify({ accessToken: 'test-token' }))
})

afterEach(() => vi.unstubAllGlobals())

describe('Aurales Sync download pagination', () => {
  it('continues after a short page that only advanced over server tombstones', async () => {
    runSyncBatchMock
      .mockResolvedValueOnce({ cursor: '500', records: [] })
      .mockResolvedValueOnce({ cursor: '501', records: [{
        recordId: 'active-profile:future-type:one', profileId: 'active-profile', type: 'future-type',
        payload: {}, updatedAt: new Date(0).toISOString(), deviceId: 'other-device', version: 1, schemaVersion: 1,
      }] })
      .mockResolvedValueOnce({ cursor: '501', records: [] })

    await expect(downloadSyncNow()).resolves.toEqual({ downloaded: 1 })
    expect(runSyncBatchMock).toHaveBeenCalledTimes(3)
    expect(runSyncBatchMock.mock.calls.map(([request]) => request.cursor)).toEqual(['0', '500', '501'])
    expect(getSyncConfig().cursor).toBe('501')
  })

  it('runs a follow-up sync after the initial profile pull so encrypted settings can be checkpointed', async () => {
    runSyncBatchMock.mockResolvedValueOnce({ cursor: '1', records: [] })

    await syncIfConfigured()

    expect(getSyncConfig().cursor).toBe('1')
    expect(scheduleAutomaticSync).toHaveBeenCalledWith(1200)
  })
})
