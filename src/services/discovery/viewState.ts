export type DiscoveryViewState='loading'|'content'|'error'
export function discoveryViewState(
  candidateCount: number,
  initialWaitComplete: boolean,
  publicTrendCount = 0,
): DiscoveryViewState {
  if (candidateCount > 0 || publicTrendCount > 0) return 'content'
  return initialWaitComplete ? 'error' : 'loading'
}
