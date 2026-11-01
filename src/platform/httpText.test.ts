import { afterEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

import { getHttpText, requestHttpText } from './httpText'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('shared HTTP text adapter', () => {
  it('uses bounded browser fetch in the web platform', async () => {
    const fetchMock = vi.fn(async () => new Response('metadata', { status: 200 }))
    vi.stubGlobal('window', {})
    vi.stubGlobal('fetch', fetchMock)

    await expect(getHttpText('https://api.example.test/meta')).resolves.toBe('metadata')
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/meta', expect.objectContaining({ method: 'GET' }))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('preserves the HTTP status and response body for browser service errors', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider unavailable', { status: 503 })))

    await expect(getHttpText('https://api.example.test/meta')).rejects.toThrow('503:provider unavailable')
  })

  it('enforces the caller response byte budget', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('more than allowed')))

    await expect(requestHttpText('https://api.example.test/meta', { maxBytes: 4 })).rejects.toThrow('exceeded the 4-byte limit')
  })

  it('keeps the established native HTTP GET command on desktop', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockResolvedValue('native metadata')

    await expect(getHttpText('https://api.example.test/meta')).resolves.toBe('native metadata')
    expect(invokeMock).toHaveBeenCalledWith('http_get_text', { url: 'https://api.example.test/meta' })
  })

  it('enforces the same response byte budget on native HTTP results', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockResolvedValue('too large')

    await expect(getHttpText('https://api.example.test/meta', { maxBytes: 4 })).rejects.toThrow('exceeded the 4-byte limit')
  })
})
