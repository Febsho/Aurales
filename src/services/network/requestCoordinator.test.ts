import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coordinatedJson, requestCoordinator } from './requestCoordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('request coordinator', () => {
  beforeEach(() => {
    requestCoordinator.resetForTests()
    vi.stubGlobal('navigator', { onLine: true })
  })

  it('deduplicates identical in-flight work', async () => {
    const gate = deferred<string>()
    const execute = vi.fn(() => gate.promise)
    const options = { origin: 'https://api.example', label: 'Example', kind: 'metadata' as const, dedupeKey: 'title:1', priority: 'visible' as const }
    const first = requestCoordinator.run(options, execute)
    const second = requestCoordinator.run(options, execute)
    expect(first).toBe(second)
    gate.resolve('ok')
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok'])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(requestCoordinator.snapshot().deduplicated).toBe(1)
  })

  it('limits addon work to one request per origin', async () => {
    const gates = [deferred<string>(), deferred<string>()]
    const started: number[] = []
    const requests = gates.map((gate, index) => requestCoordinator.run({
      origin: 'https://addon.example',
      label: 'Example addon',
      kind: 'addon',
      dedupeKey: `catalog:${index}`,
      priority: 'interactive',
    }, async () => {
      started.push(index)
      return gate.promise
    }))
    await vi.waitFor(() => expect(started).toEqual([0]))
    gates[0].resolve('one')
    await vi.waitFor(() => expect(started).toEqual([0, 1]))
    gates[1].resolve('two')
    await expect(Promise.all(requests)).resolves.toEqual(['one', 'two'])
  })

  it('limits metadata work to two per origin and four globally', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<string>())
    let active = 0
    let maxActive = 0
    const started: number[] = []
    const requests = gates.map((gate, index) => requestCoordinator.run({
      origin: index < 3 ? 'https://one.example' : `https://provider-${index}.example`,
      label: 'Metadata provider',
      kind: 'metadata',
      dedupeKey: `item:${index}`,
      priority: 'visible',
    }, async () => {
      started.push(index)
      active += 1
      maxActive = Math.max(maxActive, active)
      const value = await gate.promise
      active -= 1
      return value
    }))
    await vi.waitFor(() => expect(started.length).toBe(4))
    expect(started.filter((index) => index < 3)).toHaveLength(2)
    expect(maxActive).toBe(4)
    for (const gate of gates) gate.resolve('ok')
    await expect(Promise.all(requests)).resolves.toEqual(Array(6).fill('ok'))
  })

  it('honors Retry-After once for interactive 429 responses', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = coordinatedJson<{ ok: boolean }>('https://api.example/data', {}, {
      label: 'Example',
      kind: 'metadata',
      dedupeKey: 'data',
      priority: 'interactive',
      retry: 'interactive-once',
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestCoordinator.snapshot().rateLimited).toBe(1)
    vi.useRealTimers()
  })

  it('cancels queued work by group', async () => {
    const blocker = deferred<string>()
    const first = requestCoordinator.run({
      origin: 'https://addon.example', label: 'Addon', kind: 'addon',
      dedupeKey: 'first', priority: 'interactive',
    }, () => blocker.promise)
    const queued = requestCoordinator.run({
      origin: 'https://addon.example', label: 'Addon', kind: 'addon',
      dedupeKey: 'second', priority: 'interactive', cancelGroup: 'search:old',
    }, async () => 'unexpected')
    requestCoordinator.cancelGroup('search:old')
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    blocker.resolve('done')
    await expect(first).resolves.toBe('done')
  })

  it('pauses background work during playback and coalesces it afterward', async () => {
    const execute = vi.fn(async () => 'done')
    requestCoordinator.setPlaybackActive(true)
    const request = requestCoordinator.run({
      origin: 'https://background.example', label: 'Background provider', kind: 'metadata',
      dedupeKey: 'refresh', priority: 'background',
    }, execute)
    await Promise.resolve()
    expect(execute).not.toHaveBeenCalled()
    requestCoordinator.setPlaybackActive(false)
    await expect(request).resolves.toBe('done')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('cools down an origin after three consecutive failures', async () => {
    for (let index = 0; index < 3; index += 1) {
      await expect(requestCoordinator.run({
        origin: 'https://failing.example', label: 'Failing provider', kind: 'metadata',
        dedupeKey: `failure:${index}`, priority: 'visible',
      }, async () => { throw new Error('failed') })).rejects.toThrow('failed')
    }
    const origin = requestCoordinator.snapshot().origins[0]
    expect(origin.consecutiveFailures).toBe(3)
    expect(origin.cooldownUntil).toBeGreaterThan(Date.now())
  })
})
