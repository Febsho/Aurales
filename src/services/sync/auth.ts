import { invoke } from '@tauri-apps/api/core'
import { getMediaWorkerConfig, isIntegratedMediaWorkerBuild, isIntegratedMediaWorkerConnected, proxyAuralesSyncRequest } from '../mediaWorker'
import { readBoundedResponseJson } from '../network/boundedResponse'
import { DEFAULT_SYNC_ENDPOINT } from './auralesSync'
import { requestSyncEndpoint } from './apiTransport'

const MAX_SYNC_AUTH_RESPONSE_BYTES = 256 * 1024

type AuthResponse = { accessToken?: string; error?: string }

function parseResponse(body: string, status?: number): AuthResponse {
  let result: AuthResponse
  try { result = JSON.parse(body) as AuthResponse }
  catch { throw new Error(`Authentication failed${status ? ` (${status})` : ''}`) }
  if (!result || typeof result !== 'object') throw new Error('Invalid authentication response')
  return result
}

export async function requestSyncAuth(action: 'register' | 'login', email: string, password: string): Promise<{ accessToken: string }> {
  const normalizedEmail = email.trim().toLowerCase()
  const path = `/v1/auth/${action}` as '/v1/auth/login' | '/v1/auth/register'
  const body = JSON.stringify({ email: normalizedEmail, password })
  let result: AuthResponse
  let status: number | undefined
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    // Desktop authentication must not depend on the WebView origin being in
    // the server's CORS allow-list. Never replay a failed native request.
    let response: string
    try {
      response = await invoke<string>('http_request', {
        method: 'POST', url: `${DEFAULT_SYNC_ENDPOINT}${path}`,
        headers: { 'content-type': 'application/json' }, body,
      })
    } catch (error) {
      const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
      const match = /^(\d{3}):(.*)$/s.exec(message)
      if (match) {
        status = Number(match[1])
        const failure = parseResponse(match[2], status)
        throw new Error(typeof failure.error === 'string' ? failure.error : `Authentication failed (${status})`)
      }
      throw new Error('Could not connect to Aurales Sync. Check your network connection and try again.')
    }
    if (new TextEncoder().encode(response).byteLength > MAX_SYNC_AUTH_RESPONSE_BYTES) throw new Error('Authentication response is too large')
    result = parseResponse(response)
  } else {
    // A self-hosted browser cannot call the first-party Sync origin directly:
    // its CORS policy only permits the official web origin. Integrated builds
    // must first establish their same-origin, HttpOnly worker session.
    if (isIntegratedMediaWorkerBuild() && !isIntegratedMediaWorkerConnected()) {
      throw new Error('Unlock the Aurales media service in Settings before signing in to Aurales Sync.')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new DOMException('Authentication request timed out', 'TimeoutError')), 15_000)
    try {
      if (getMediaWorkerConfig()) {
        const relayed = await proxyAuralesSyncRequest(path, body, undefined, controller.signal)
        status = relayed.status
        result = parseResponse(relayed.body, status)
        if (!relayed.ok) throw new Error(result.error || `Authentication failed (${status})`)
      } else {
        const response = await requestSyncEndpoint(DEFAULT_SYNC_ENDPOINT, path, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
        })
        status = response.status
        result = await readBoundedResponseJson<AuthResponse>(response, MAX_SYNC_AUTH_RESPONSE_BYTES, 'Sync authentication response')
        if (!response.ok) throw new Error(result.error || `Authentication failed (${status})`)
      }
    } finally { clearTimeout(timeout) }
  }
  if (typeof result.accessToken !== 'string' || !result.accessToken) throw new Error(result.error || `Authentication failed${status ? ` (${status})` : ''}`)
  return { accessToken: result.accessToken }
}
