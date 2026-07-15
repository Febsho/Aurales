// Startup coordination used to make unrelated Home work wait for artwork or
// Continue Watching. Keep these functions for existing callers, but never
// gate metadata or catalog loading on another part of the page.
export function markHeroImageSettled(): void {}

export function waitForHeroImageSettled(): Promise<void> {
  return Promise.resolve()
}

export function markContinueWatchingSettled(): void {}

export function waitForContinueWatchingSettled(): Promise<void> {
  return Promise.resolve()
}
