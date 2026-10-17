/** Run a request with a bounded AbortController deadline on every WebView. */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  message = 'Request timed out',
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parentSignal?.reason || new DOMException('Request cancelled', 'AbortError'))
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(message, 'TimeoutError'))
  }, timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}
