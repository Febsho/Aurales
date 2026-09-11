import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import type { SmartScoreContext, SmartStream } from './smartScoring'
import { rankStreams } from './smartScoring'
import { rankStreamCandidates } from './nativeScoring'

const context: SmartScoreContext = { title: 'Example Movie', mode: 'best', player: 'mpv' }
const stream = (title: string, addonId: string): SmartStream => ({
  title, addonId, addonName: addonId, url: `https://example.com/${encodeURIComponent(title)}.mp4`,
})

describe('native stream ranking compatibility wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, location: { origin: 'http://tauri.localhost' } })
  })

  it('returns the typed native batch without changing stream objects', async () => {
    const candidate = stream('Example Movie 1080p WEB-DL', 'one')
    invokeMock.mockResolvedValue({
      stale: false,
      candidates: [{ stream: candidate, score: 72, reasons: ['player compatible'], fingerprint: 'one:url:https://example.com/a' }],
    })
    await expect(rankStreamCandidates([candidate], context)).resolves.toEqual([
      { stream: candidate, score: 72, reasons: ['player compatible'] },
    ])
    expect(invokeMock).toHaveBeenCalledWith('rank_stream_candidates', expect.objectContaining({
      request: expect.objectContaining({ streams: [candidate], context: expect.objectContaining(context) }),
    }))
  })

  it('preserves the complete TypeScript scorer as native-failure fallback', async () => {
    const candidates = [
      stream('Example Movie trailer 2160p', 'one'),
      stream('Example Movie 1080p WEB-DL', 'two'),
    ]
    invokeMock.mockRejectedValue(new Error('native unavailable'))
    await expect(rankStreamCandidates(candidates, context)).resolves.toEqual(rankStreams(candidates, context))
  })

  it('does not let an older A to B ranking complete after newer navigation', async () => {
    const resolvers = new Map<string, (value: unknown) => void>()
    invokeMock.mockImplementation((_command: string, args: { request: { context: SmartScoreContext } }) => new Promise(resolve => {
      resolvers.set(args.request.context.title, resolve)
    }))
    const first = rankStreamCandidates([stream('A 1080p', 'a')], { ...context, title: 'A' }, { cancelGroup: 'rapid' })
    const second = rankStreamCandidates([stream('B 1080p', 'b')], { ...context, title: 'B' }, { cancelGroup: 'rapid' })
    await vi.waitFor(() => expect(resolvers.size).toBe(2))
    resolvers.get('B')?.({ stale: false, candidates: [] })
    await expect(second).resolves.toEqual([])
    resolvers.get('A')?.({ stale: false, candidates: [] })
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('never falls back for a stale native completion', async () => {
    invokeMock.mockResolvedValue({ stale: true, candidates: [] })
    await expect(rankStreamCandidates([stream('A', 'a')], context)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps empty batches empty in both native and fallback modes', async () => {
    invokeMock.mockResolvedValue({ stale: false, candidates: [] })
    await expect(rankStreamCandidates([], context)).resolves.toEqual([])
    invokeMock.mockRejectedValue(new Error('offline'))
    await expect(rankStreamCandidates([], { ...context, title: 'fallback' })).resolves.toEqual([])
  })
})
