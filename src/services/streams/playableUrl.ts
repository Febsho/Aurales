import type { StreamResult } from '../../types'

function isBlockedAppUrl(value: string): boolean {
  const lower = value.trim().toLowerCase()
  if (
    lower.startsWith('aurales://') ||
    lower.startsWith('orynt://') ||
    lower.startsWith('file://') ||
    lower.startsWith('tauri://')
  ) {
    return true
  }

  try {
    const parsed = new URL(value)
    return typeof window !== 'undefined' && parsed.origin === window.location.origin
  } catch (_) {
    return false
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export function getPlayableStreamUrl(stream: StreamResult): string | null {
  if (stream.url && isHttpUrl(stream.url) && !isBlockedAppUrl(stream.url)) {
    return stream.url
  }

  if (stream.externalUrl && isHttpUrl(stream.externalUrl) && !isBlockedAppUrl(stream.externalUrl)) {
    return stream.externalUrl
  }

  if (stream.ytId) {
    return `https://www.youtube.com/watch?v=${stream.ytId}`
  }
  return null
}

export function isPlayableStream(stream: StreamResult): boolean {
  return getPlayableStreamUrl(stream) !== null
}
