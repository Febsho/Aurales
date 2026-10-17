import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDetailSessionCache, getSessionDetail, rememberSessionDetail } from './detailSessionCache'

describe('detail session cache', () => {
  beforeEach(() => {
    vi.useRealTimers()
    clearDetailSessionCache()
  })

  it('returns core metadata synchronously on a revisit', () => {
    const detail = { id: 'movie-1', title: 'Cached movie' }
    rememberSessionDetail('movie:movie-1', detail)
    expect(getSessionDetail<typeof detail>('movie:movie-1')).toEqual({ data: detail, stale: false })
  })

  it('keeps stale data renderable for background revalidation', () => {
    vi.useFakeTimers()
    rememberSessionDetail('movie:stale', { title: 'Still valid' })
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)
    expect(getSessionDetail<{ title: string }>('movie:stale')).toEqual({ data: { title: 'Still valid' }, stale: true })
  })

  it('bounds large detail objects while retaining recently used entries', () => {
    for (let index = 0; index < 101; index += 1) rememberSessionDetail(`movie:${index}`, { index })
    expect(getSessionDetail('movie:0')).toBeNull()
    expect(getSessionDetail('movie:100')).toEqual({ data: { index: 100 }, stale: false })
  })
})
