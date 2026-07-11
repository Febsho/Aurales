import { describe, expect, it } from 'vitest'
import { SmartFallbackQueue } from './smartFallback'

describe('SmartFallbackQueue', () => {
  it('tries each ranked stream once and stops when exhausted', () => {
    const queue = new SmartFallbackQueue(['best', 'second', 'third'])
    expect(queue.next()).toBe('best')
    expect(queue.next()).toBe('second')
    expect(queue.remaining()).toBe(1)
    expect(queue.next()).toBe('third')
    expect(queue.next()).toBeNull()
  })
})
