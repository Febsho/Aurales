// Keep route imports explicit so Vite retains the existing feature chunks.
// These are invoked only on user intent or during browser idle time; importing
// them here does not make the routes part of the startup chunk.
const routeLoaders: Record<string, () => Promise<unknown>> = {
  '/search': () => import('../pages/SearchPage'),
  '/discover': () => import('../pages/DiscoverPage'),
  '/upcoming': () => import('../pages/UpcomingPage'),
  '/collections': () => import('../pages/CollectionsPage'),
  '/settings': () => import('../pages/SettingsPage'),
  '/watch-together': () => import('../pages/WatchTogetherPage'),
}

const prefetched = new Set<string>()

export function prefetchRoute(path: string): void {
  const loader = routeLoaders[path]
  if (!loader || prefetched.has(path)) return
  prefetched.add(path)
  void loader().catch(() => prefetched.delete(path))
}

export function prefetchLikelyRoutes(): () => void {
  const run = () => {
    prefetchRoute('/search')
    prefetchRoute('/discover')
    prefetchRoute('/collections')
  }
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const id = idleWindow.requestIdleCallback(run, { timeout: 4000 })
    return () => idleWindow.cancelIdleCallback?.(id)
  }
  const id = window.setTimeout(run, 2500)
  return () => window.clearTimeout(id)
}
