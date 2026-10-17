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
const STORAGE_PREFIX = 'aurales_view_state_v1:profile:'

const routeScroll = new Map<string, number>()
const shelfViews = new Map<string, ShelfViewState>()
const detailViews = new Map<string, DetailViewState>()
let homeShelfId: string | null = null
let loadedProfile: string | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null

function activeProfile(): string {
  try { return localStorage.getItem('aurales_active_profile_v1') || 'default' } catch { return 'default' }
}

function hydrate(): void {
  const profile = activeProfile()
  if (loadedProfile === profile) return
  if (persistTimer) persist()
  routeScroll.clear(); shelfViews.clear(); detailViews.clear(); homeShelfId = null
  loadedProfile = profile
  try {
    const raw = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${profile}`) || 'null') as {
      version?: number
      routes?: [string, number][]
      shelves?: [string, ShelfViewState][]
      details?: [string, DetailViewState][]
      homeShelfId?: string
    } | null
    if (raw?.version !== 1) return
    if (typeof raw.homeShelfId === 'string') homeShelfId = raw.homeShelfId
    for (const [key, value] of (Array.isArray(raw.routes) ? raw.routes : []).slice(-MAX_ROUTE_ENTRIES)) {
      if (typeof key === 'string' && Number.isFinite(value)) routeScroll.set(key, Math.max(0, value))
    }
    for (const [key, value] of (Array.isArray(raw.shelves) ? raw.shelves : []).slice(-MAX_SHELF_ENTRIES)) {
      if (typeof key === 'string' && value && Number.isFinite(value.scrollLeft) && Number.isFinite(value.renderedCount)) {
        shelfViews.set(key, { scrollLeft: Math.max(0, value.scrollLeft), renderedCount: Math.max(1, Math.floor(value.renderedCount)) })
      }
    }
    for (const [key, value] of (Array.isArray(raw.details) ? raw.details : []).slice(-MAX_DETAIL_VIEW_ENTRIES)) {
      if (typeof key === 'string' && value && typeof value === 'object') detailViews.set(key, value)
    }
  } catch { /* Start with empty positions if storage is unavailable. */ }
}

function persist(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  if (!loadedProfile) return
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${loadedProfile}`, JSON.stringify({
      version: 1,
      routes: [...routeScroll], shelves: [...shelfViews], details: [...detailViews],
      homeShelfId,
    }))
  } catch { /* Navigation continues in memory. */ }
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persist, 200)
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', persist)

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
  hydrate()
  rememberBounded(routeScroll, key, Math.max(0, scrollTop), MAX_ROUTE_ENTRIES)
  schedulePersist()
}

export function getRouteScroll(key: string): number | undefined {
  hydrate()
  return routeScroll.get(key)
}

export function rememberShelfView(key: string, state: ShelfViewState): void {
  hydrate()
  rememberBounded(shelfViews, key, {
    scrollLeft: Math.max(0, state.scrollLeft),
    renderedCount: Math.max(1, Math.floor(state.renderedCount)),
  }, MAX_SHELF_ENTRIES)
  schedulePersist()
}

export function getShelfView(key: string): ShelfViewState | undefined {
  hydrate()
  return shelfViews.get(key)
}

export function rememberDetailView(key: string, patch: Partial<DetailViewState>): void {
  hydrate()
  const current = detailViews.get(key) || {}
  rememberBounded(detailViews, key, {
    ...current,
    ...patch,
    ...(patch.selectedSeason != null && { selectedSeason: Math.max(0, Math.floor(patch.selectedSeason)) }),
    ...(patch.episodeScrollLeft != null && { episodeScrollLeft: Math.max(0, patch.episodeScrollLeft) }),
    ...(patch.renderedEpisodeCount != null && { renderedEpisodeCount: Math.max(1, Math.floor(patch.renderedEpisodeCount)) }),
  }, MAX_DETAIL_VIEW_ENTRIES)
  schedulePersist()
}

export function getDetailView(key: string): DetailViewState | undefined {
  hydrate()
  return detailViews.get(key)
}

export function rememberHomeShelfId(id: string): void {
  hydrate()
  homeShelfId = id
  schedulePersist()
}

export function getHomeShelfId(): string | null {
  hydrate()
  return homeShelfId
}

export function clearSessionViewState(): void {
  hydrate()
  routeScroll.clear()
  shelfViews.clear()
  detailViews.clear()
  homeShelfId = null
  persist()
}

export function flushSessionViewState(): void {
  hydrate()
  persist()
}
