export class SmartFallbackQueue<T> {
  private index = -1
  private readonly candidates: T[]
  constructor(candidates: T[]) { this.candidates = candidates }
  next(): T | null { this.index += 1; return this.candidates[this.index] ?? null }
  remaining(): number { return Math.max(0, this.candidates.length - this.index - 1) }
}
