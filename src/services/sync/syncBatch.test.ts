import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runSyncBatch } from './syncBatch'

const input = {
  endpoint: 'https://sync.example', accessToken: 'secret', schemaVersion: 1,
  deviceId: 'device', deviceName: 'Desktop', cursor: '4', records: [], mode: 'sync' as const,
}

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => vi.clearAllMocks())

describe('coarse sync batch', () => {
  it('uses one native operation and preserves the server response', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockResolvedValue({ cursor: '5', records: [{ recordId: 'one' }], stale: false })
    await expect(runSyncBatch(input)).resolves.toEqual({ cursor: '5', records: [{ recordId: 'one' }] })
    expect(invokeMock).toHaveBeenCalledWith('sync_batch', { request: expect.objectContaining({ cursor: '4', cancelGroup: 'aurales-sync:account' }) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps injected/browser fetching as the compatibility path', async () => {
    vi.stubGlobal('window', {})
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ cursor: '5', records: [] }) })) as unknown as typeof fetch
    await expect(runSyncBatch(input, fetcher)).resolves.toEqual({ cursor: '5', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('uses the compatibility transport for an older binary without sync_batch', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ cursor: '5', records: [] }) })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockRejectedValue(new Error('Command sync_batch not found'))
    await expect(runSyncBatch(input)).resolves.toEqual({ cursor: '5', records: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not replay an uncertain native sync failure through fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockRejectedValue(new Error('network request timed out'))
    await expect(runSyncBatch(input)).rejects.toThrow('network request timed out')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not mistake a server error body for a missing native command', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockRejectedValue(new Error('HTTP 500: command sync_batch not found'))
    await expect(runSyncBatch(input)).rejects.toThrow('HTTP 500')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
