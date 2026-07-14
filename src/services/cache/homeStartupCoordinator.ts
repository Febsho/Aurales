let heroSettled = false
let continueSettled = false
let resolveHero!: () => void
let resolveContinue!: () => void

const heroPromise = new Promise<void>((resolve) => { resolveHero = resolve })
const continuePromise = new Promise<void>((resolve) => { resolveContinue = resolve })

const fallback = typeof window !== 'undefined'
  ? window.setTimeout(() => markHeroImageSettled(), 750)
  : undefined
const continueFallback = typeof window !== 'undefined'
  ? window.setTimeout(() => markContinueWatchingSettled(), 1000)
  : undefined

export function markHeroImageSettled(): void {
  if (heroSettled) return
  heroSettled = true
  if (fallback != null && typeof window !== 'undefined') window.clearTimeout(fallback)
  resolveHero()
}

export function waitForHeroImageSettled(): Promise<void> {
  return heroPromise
}

export function markContinueWatchingSettled(): void {
  if (continueSettled) return
  continueSettled = true
  if (continueFallback != null && typeof window !== 'undefined') window.clearTimeout(continueFallback)
  resolveContinue()
}

export function waitForContinueWatchingSettled(): Promise<void> {
  return continuePromise
}
