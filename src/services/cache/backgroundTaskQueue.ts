// [PERF] logs are dev-only — they add noise and cost in production builds
const perfLog: (...args: unknown[]) => void = import.meta.env.DEV ? console.log : () => {}

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low' | 'idle'

const PRIORITY_ORDER: TaskPriority[] = ['critical', 'high', 'normal', 'low', 'idle']

export interface BackgroundTask {
  id: string
  priority: TaskPriority
  execute: () => Promise<void>
  dedupKey?: string
}

class BackgroundTaskQueue {
  private queues = new Map<TaskPriority, BackgroundTask[]>(
    PRIORITY_ORDER.map((p) => [p, []])
  )
  private running = new Map<string, { promise: Promise<void>; dedupKey?: string }>()
  private maxConcurrent = 3

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

      const task = queue.shift()!
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

      this.running.set(task.id, { promise, dedupKey: task.dedupKey })
      this.processNext()
      return
    }
  }
}

export const taskQueue = new BackgroundTaskQueue()
