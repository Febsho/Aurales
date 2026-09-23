interface ShelfViewState {
  scrollLeft: number
  renderedCount: number
}

export interface DetailViewState {
  selectedSeason?: number
  focusedTarget?: string
  expandedOverview?: boolean
  episodeScrollLeft?: number
  renderedEpisodeCount?: number
}

const MAX_ROUTE_ENTRIES = 80
const MAX_SHELF_ENTRIES = 240
const MAX_DETAIL_VIEW_ENTRIES = 100

const routeScroll = new Map<string, number>()
const shelfViews = new Map<string, ShelfViewState>()
const detailViews = new Map<string, DetailViewState>()

function rememberBounded<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest == null) break
    map.delete(oldest)
  }
}

export function routeViewKey(pathname: string, search = ''): string {
  return `${pathname}${search}`
}

export function rememberRouteScroll(key: string, scrollTop: number): void {
  rememberBounded(routeScroll, key, Math.max(0, scrollTop), MAX_ROUTE_ENTRIES)
}

export function getRouteScroll(key: string): number | undefined {
  return routeScroll.get(key)
}

export function rememberShelfView(key: string, state: ShelfViewState): void {
  rememberBounded(shelfViews, key, {
    scrollLeft: Math.max(0, state.scrollLeft),
    renderedCount: Math.max(1, Math.floor(state.renderedCount)),
  }, MAX_SHELF_ENTRIES)
}

export function getShelfView(key: string): ShelfViewState | undefined {
  return shelfViews.get(key)
}

export function rememberDetailView(key: string, patch: Partial<DetailViewState>): void {
  const current = detailViews.get(key) || {}
  rememberBounded(detailViews, key, {
    ...current,
    ...patch,
    ...(patch.selectedSeason != null && { selectedSeason: Math.max(0, Math.floor(patch.selectedSeason)) }),
    ...(patch.episodeScrollLeft != null && { episodeScrollLeft: Math.max(0, patch.episodeScrollLeft) }),
    ...(patch.renderedEpisodeCount != null && { renderedEpisodeCount: Math.max(1, Math.floor(patch.renderedEpisodeCount)) }),
  }, MAX_DETAIL_VIEW_ENTRIES)
}

export function getDetailView(key: string): DetailViewState | undefined {
  return detailViews.get(key)
}

export function clearSessionViewState(): void {
  routeScroll.clear()
  shelfViews.clear()
  detailViews.clear()
}
