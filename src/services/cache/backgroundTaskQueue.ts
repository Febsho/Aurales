// [PERF] logs are dev-only — they add noise and cost in production builds
const perfLog: (...args: unknown[]) => void = import.meta.env.DEV ? console.log : () => {}

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low' | 'idle'

const PRIORITY_ORDER: TaskPriority[] = ['critical', 'high', 'normal', 'low', 'idle']

export interface BackgroundTask {
  id: string
  priority: TaskPriority
  execute: () => Promise<void>
  dedupKey?: string
  group?: 'metadata'
}

class BackgroundTaskQueue {
  private maxConcurrent: number
  private groupLimits: Partial<Record<NonNullable<BackgroundTask['group']>, number>>
  private queues = new Map<TaskPriority, BackgroundTask[]>(
    PRIORITY_ORDER.map((p) => [p, []])
  )
  private running = new Map<string, { promise: Promise<void>; dedupKey?: string; group?: BackgroundTask['group'] }>()
  constructor(maxConcurrent = 2, groupLimits: Partial<Record<NonNullable<BackgroundTask['group']>, number>> = {}) {
    this.maxConcurrent = maxConcurrent
    this.groupLimits = groupLimits
  }

  enqueue(task: BackgroundTask): void {
    if (task.dedupKey) {
      for (const [, entry] of this.running) {
        if (entry.dedupKey === task.dedupKey) {
          perfLog(`[PERF] task-dedup id=${task.id} dedupKey=${task.dedupKey} (running)`)
          return
        }
      }
      for (const [, queue] of this.queues) {
        const idx = queue.findIndex((t) => t.dedupKey === task.dedupKey)
        if (idx !== -1) {
          queue[idx] = task
          perfLog(`[PERF] task-replaced id=${task.id} dedupKey=${task.dedupKey}`)
          return
        }
      }
    }

    this.queues.get(task.priority)!.push(task)
    perfLog(`[PERF] task-enqueue id=${task.id} priority=${task.priority}`)
    this.processNext()
  }

  cancel(taskId: string): boolean {
    for (const [, queue] of this.queues) {
      const idx = queue.findIndex((t) => t.id === taskId)
      if (idx !== -1) {
        queue.splice(idx, 1)
        return true
      }
    }
    return false
  }

  getStatus() {
    const byPriority: Record<TaskPriority, number> = {} as Record<TaskPriority, number>
    let queued = 0
    for (const p of PRIORITY_ORDER) {
      const count = this.queues.get(p)!.length
      byPriority[p] = count
      queued += count
    }
    return { queued, running: this.running.size, byPriority }
  }

  private processNext(): void {
    if (this.running.size >= this.maxConcurrent) return

    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues.get(priority)!
      if (queue.length === 0) continue

      const runnableIndex = queue.findIndex((candidate) => {
        if (!candidate.group) return true
        const limit = this.groupLimits[candidate.group]
        if (limit == null) return true
        let runningInGroup = 0
        for (const entry of this.running.values()) if (entry.group === candidate.group) runningInGroup += 1
        return runningInGroup < limit
      })
      if (runnableIndex === -1) continue
      const [task] = queue.splice(runnableIndex, 1)
      const t0 = performance.now()
      perfLog(`[PERF] task-start id=${task.id} priority=${task.priority}`)

      const promise = task
        .execute()
        .then(() => {
          perfLog(`[PERF] task-complete id=${task.id} duration=${Math.round(performance.now() - t0)}ms`)
        })
        .catch((e) => {
          console.error(`[PERF] task-error id=${task.id}`, e)
        })
        .finally(() => {
          this.running.delete(task.id)
          this.processNext()
        })

      this.running.set(task.id, { promise, dedupKey: task.dedupKey, group: task.group })
      this.processNext()
      return
    }
  }
}

export const taskQueue = new BackgroundTaskQueue(3)
export const startupTaskQueue = new BackgroundTaskQueue(2, { metadata: 1 })
// Restore the pre-startup-optimization behavior: metadata work can make the
// same three concurrent requests as normal work instead of serializing every
// anime/show lookup behind one global task.
export const metadataTaskQueue = new BackgroundTaskQueue(3)
const scheduledPromises = new Map<string, Promise<unknown>>()

export function scheduleTask<T>(
  queue: BackgroundTaskQueue,
  task: Omit<BackgroundTask, 'execute'> & { execute: () => Promise<T> },
): Promise<T> {
  const key = task.dedupKey
  const existing = key ? scheduledPromises.get(key) as Promise<T> | undefined : undefined
  if (existing) return existing
  const promise = new Promise<T>((resolve, reject) => {
    queue.enqueue({
      ...task,
      execute: async () => {
        try { resolve(await task.execute()) } catch (error) { reject(error) }
      },
    })
  })
  if (!key) return promise
  const tracked = promise.finally(() => scheduledPromises.delete(key))
  scheduledPromises.set(key, tracked)
  return tracked
}
