import { describe, expect, it, vi } from 'vitest'
import { metadataTaskQueue, scheduleTask, startupTaskQueue } from './backgroundTaskQueue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('background task scheduling', () => {
  it('limits general startup work to two concurrent tasks', async () => {
    const gates = [deferred(), deferred(), deferred()]
    const started: number[] = []
    const tasks = gates.map((gate, index) => scheduleTask(startupTaskQueue, {
      id: `concurrency-${index}`,
      priority: 'normal',
      execute: async () => { started.push(index); await gate.promise; return index },
    }))

    await Promise.resolve()
    expect(started).toEqual([0, 1])
    gates[0].resolve()
    await tasks[0]
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]))
    gates[1].resolve()
    gates[2].resolve()
    await Promise.all(tasks)
  })

  it('serializes metadata work and shares deduplicated promises', async () => {
    const first = deferred()
    const execute = vi.fn(async () => { await first.promise; return 'done' })
    const a = scheduleTask(metadataTaskQueue, { id: 'meta-a', dedupKey: 'same-meta', priority: 'low', group: 'metadata', execute })
    const b = scheduleTask(metadataTaskQueue, { id: 'meta-b', dedupKey: 'same-meta', priority: 'low', group: 'metadata', execute })
    expect(a).toBe(b)
    first.resolve()
    await expect(Promise.all([a, b])).resolves.toEqual(['done', 'done'])
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('allows metadata tasks to use normal queue concurrency', async () => {
    const first = deferred()
    const started: string[] = []
    const a = scheduleTask(metadataTaskQueue, {
      id: 'serial-meta-a', priority: 'low', group: 'metadata',
      execute: async () => { started.push('a'); await first.promise },
    })
    const b = scheduleTask(metadataTaskQueue, {
      id: 'serial-meta-b', priority: 'low', group: 'metadata',
      execute: async () => { started.push('b') },
    })
    await Promise.resolve()
    expect(started).toEqual(['a', 'b'])
    first.resolve()
    await a
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']))
    await b
  })
})
