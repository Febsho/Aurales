import { invoke } from '@tauri-apps/api/core'
import { getPlatformCapabilities } from './capabilities'
import { readBoundedResponseText } from '../services/network/boundedResponse'
import { withRequestTimeout } from '../services/network/timeout'

const MAX_TEXT_RESPONSE_BYTES = 16 * 1024 * 1024

export interface HttpTextOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
  maxBytes?: number
}

function enforceByteBudget(text: string, maxBytes: number): string {
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`HTTP text response exceeded the ${maxBytes}-byte limit`)
  }
  return text
}

/**
 * Text HTTP adapter shared by desktop and browser services. Tauri keeps its
 * existing native request contract; browsers use fetch and therefore retain
 * normal CORS enforcement instead of silently relying on a proxy.
 */
export async function requestHttpText(url: string, options: HttpTextOptions = {}): Promise<string> {
  const method = options.method || 'GET'
  if (getPlatformCapabilities().platform === 'tauri') {
    if (method === 'GET' && !options.headers && options.body === undefined) {
      return enforceByteBudget(await invoke<string>('http_get_text', { url }), options.maxBytes ?? MAX_TEXT_RESPONSE_BYTES)
    }
    const text = await invoke<string>('http_request', {
      method,
      url,
      headers: options.headers || {},
      body: options.body ?? null,
    })
    return enforceByteBudget(text, options.maxBytes ?? MAX_TEXT_RESPONSE_BYTES)
  }

  return withRequestTimeout(options.timeoutMs ?? 30_000, async (signal) => {
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      signal,
    })
    const text = await readBoundedResponseText(
      response,
      options.maxBytes ?? MAX_TEXT_RESPONSE_BYTES,
      'HTTP text response',
    )
    if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 8_192)}`)
    return text
  }, 'HTTP request timed out', options.signal)
}

export function getHttpText(url: string, options: Omit<HttpTextOptions, 'method' | 'body'> = {}): Promise<string> {
  return requestHttpText(url, { ...options, method: 'GET' })
}
