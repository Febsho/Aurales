interface ShelfViewState {
  scrollLeft: number
  renderedCount: number
}

const MAX_ROUTE_ENTRIES = 80
const MAX_SHELF_ENTRIES = 240

const routeScroll = new Map<string, number>()
const shelfViews = new Map<string, ShelfViewState>()

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

export function clearSessionViewState(): void {
  routeScroll.clear()
  shelfViews.clear()
}

