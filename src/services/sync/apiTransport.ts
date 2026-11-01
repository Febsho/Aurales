const LOCAL_SYNC_PROXY = '/__aurales_sync'

function isPrivateLanIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254)
    || parts[0] === 127
}

function shouldTryLocalProxy(): boolean {
  if (typeof window === 'undefined') return false
  const { hostname, protocol } = window.location
  return protocol === 'http:'
    && (hostname === 'localhost' || hostname === '::1' || isPrivateLanIpv4(hostname))
}

/**
 * Use the normal first-party Sync API first. Local Vite web previews cannot be
 * added to the production Sync CORS allow-list, so retry those requests through
 * the preview server's fixed-origin proxy. Production self-hosts use the
 * authenticated same-origin media-worker relay instead.
 */
export async function requestSyncEndpoint(
  endpoint: string,
  path: '/v1/auth/login' | '/v1/auth/register' | '/v1/sync',
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = `${endpoint.replace(/\/$/, '')}${path}`
  try {
    return await fetcher(url, init)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    if (fetcher !== fetch || !shouldTryLocalProxy()) {
      throw new Error('Aurales Sync is blocked by the browser. Unlock the integrated media service or allow this exact HTTPS app origin in the Sync server CORS_ORIGIN setting.')
    }
    try {
      return await fetcher(`${LOCAL_SYNC_PROXY}${path}`, init)
    } catch {
      throw new Error('Aurales Sync could not be reached. Restart the local Aurales Vite server with its Sync proxy enabled, or use the authenticated integrated media service.')
    }
  }
}
