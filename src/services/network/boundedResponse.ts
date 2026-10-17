/** Read a response body without buffering more than the caller's byte budget. */
export async function readBoundedResponseText(response: Response, maxBytes: number, label: string): Promise<string> {
  const contentLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${label} exceeded the ${maxBytes}-byte limit`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`${label} exceeded the ${maxBytes}-byte limit`)
    }
    return text
  }

  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} exceeded the ${maxBytes}-byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function readBoundedResponseJson<T>(response: Response, maxBytes: number, label: string): Promise<T> {
  return JSON.parse(await readBoundedResponseText(response, maxBytes, label)) as T
}
