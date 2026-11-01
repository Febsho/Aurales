import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForSubtitleMirror } from './subtitleMirror'

describe('subtitle mirror scheduling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for decoded playback and three seconds of buffered video', async () => {
    let ready = false
    const readState = vi.fn()
      .mockResolvedValueOnce({ hasEmbeddedSubtitles: true, bufferedSeconds: 1 })
      .mockResolvedValue({ hasEmbeddedSubtitles: true, bufferedSeconds: 3 })
    const pending = waitForSubtitleMirror({ isCurrent: () => true, isReady: () => ready, readState })
    await vi.advanceTimersByTimeAsync(1000)
    expect(readState).not.toHaveBeenCalled()
    ready = true
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe(true)
    expect(readState).toHaveBeenCalledTimes(2)
  })

  it('does not reopen videos without embedded subtitles', async () => {
    const readState = vi.fn().mockResolvedValue({ hasEmbeddedSubtitles: false, bufferedSeconds: 20 })
    const pending = waitForSubtitleMirror({ isCurrent: () => true, isReady: () => true, readState })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe(false)
    expect(readState).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight result after switching streams', async () => {
    let current = true
    let resolveState!: (state: { hasEmbeddedSubtitles: boolean; bufferedSeconds: number }) => void
    const readState = vi.fn(() => new Promise<{ hasEmbeddedSubtitles: boolean; bufferedSeconds: number }>((resolve) => { resolveState = resolve }))
    const pending = waitForSubtitleMirror({ isCurrent: () => current, isReady: () => true, readState })
    await vi.advanceTimersByTimeAsync(500)
    current = false
    resolveState({ hasEmbeddedSubtitles: true, bufferedSeconds: 20 })
    await expect(pending).resolves.toBe(false)
  })

  it('gives up without reopening an unbuffered stream', async () => {
    const readState = vi.fn().mockResolvedValue({ hasEmbeddedSubtitles: true, bufferedSeconds: null })
    const pending = waitForSubtitleMirror({ isCurrent: () => true, isReady: () => true, readState })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBe(false)
    expect(readState).toHaveBeenCalledTimes(30)
  })
})
