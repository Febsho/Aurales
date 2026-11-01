import { describe, expect, it } from 'vitest'
// The application tsconfig intentionally exposes browser types only; Vitest
// still runs this source-contract test in Node.
// @ts-expect-error node:fs is available in the test runtime.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('./DetailContentShell.tsx', import.meta.url), 'utf8')
const stickySource = readFileSync(new URL('./DetailStickyHeader.tsx', import.meta.url), 'utf8')
const seriesSource = readFileSync(new URL('../../pages/SeriesDetailPage.tsx', import.meta.url), 'utf8')
const discoverSource = readFileSync(new URL('../../pages/DiscoverPage.tsx', import.meta.url), 'utf8')
const mobileNavigationSource = readFileSync(new URL('../MobileWebNavigation.tsx', import.meta.url), 'utf8')

describe('cinematic detail responsive and scroll contracts', () => {
  it('keeps the hero within the requested cinematic viewport range', () => {
    expect(css).toContain('height: clamp(34rem, 68svh, 55rem)')
    expect(css).toContain('@media (max-width: 820px) and (max-height: 650px)')
    expect(css).toContain('height: 68svh !important')
  })

  it('constrains ultrawide copy instead of stretching it', () => {
    expect(css).toContain('@media (min-aspect-ratio: 21 / 9) and (min-width: 1800px)')
    expect(css).toContain('max-width: 54rem')
  })

  it('does not unmount or wheel-snap loaded detail rows while scrolling', () => {
    expect(shellSource).not.toContain('handleWheel')
    expect(shellSource).not.toContain('contentActive')
    expect(shellSource).toContain('{children}')
  })

  it('reveals the compact header from hero visibility without reserving layout space', () => {
    expect(stickySource).toContain('IntersectionObserver')
    expect(stickySource).toContain('entry.intersectionRatio <= 0.08')
    expect(css).toContain('.detail-sticky-anchor')
    expect(css).toContain('height: 0')
  })

  it('respects reduced motion globally', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('transition-duration: 0.01ms !important')
  })

  it('keeps episode details still on thumbnail hover and seasons in the app menu', () => {
    expect(css).not.toContain('.detail-page .episode-showcase-card:hover,')
    expect(seriesSource).toContain("import SelectMenu from '../components/ui/SelectMenu'")
    expect(seriesSource).toContain('className="detail-season-menu"')
  })

  it('keeps mobile shelves, discovery hero, details, and navigation inside touch-sized layouts', () => {
    expect(css).toContain('.media-row--ranked .media-row-card-slot > button')
    expect(css).toContain('--ranked-card-height: clamp(7.25rem, 31vw, 8.25rem)')
    expect(css).toContain('.discover-hero { min-height: 370px !important;')
    expect(css).toContain('.detail-page .episode-showcase-card { width: min(48vw, 17rem); }')
    expect(css).toContain('.detail-page .detail-hero-actions {')
    expect(css).toContain('flex-direction: column-reverse')
    expect(css).toContain('.cinematic-nav-capsule::-webkit-scrollbar { display: none; }')
    expect(css).toContain('.discover-page__heading h1')
    expect(css).toContain('.mobile-web-nav {')
    expect(css).toContain('env(safe-area-inset-bottom)')
    expect(discoverSource).toContain('className="discover-page pb-12"')
    expect(discoverSource).toContain('className="discover-hero group relative')
    expect(mobileNavigationSource).toContain('aria-label="Mobile navigation"')
  })
})
