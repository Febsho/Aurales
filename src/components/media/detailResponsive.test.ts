import { describe, expect, it } from 'vitest'
// The application tsconfig intentionally exposes browser types only; Vitest
// still runs this source-contract test in Node.
// @ts-expect-error node:fs is available in the test runtime.
import { readFileSync } from 'node:fs'

const readSource = (url: URL) => readFileSync(url, 'utf8').replace(/\r\n/g, '\n')
const css = readSource(new URL('../../index.css', import.meta.url))
const shellSource = readSource(new URL('./DetailContentShell.tsx', import.meta.url))
const stickySource = readSource(new URL('./DetailStickyHeader.tsx', import.meta.url))
const seriesSource = readSource(new URL('../../pages/SeriesDetailPage.tsx', import.meta.url))
const discoverSource = readSource(new URL('../../pages/DiscoverPage.tsx', import.meta.url))
const mobileNavigationSource = readSource(new URL('../MobileWebNavigation.tsx', import.meta.url))

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
    expect(css).toContain('--ranked-card-height: clamp(10.5rem, 42vw, 11.25rem)')
    expect(css).toContain('.discover-spotlight {')
    expect(css).not.toContain('.discover-mode-menu')
    expect(css).not.toContain('.discover-hero')
    expect(css).toContain('.discover-spotlight { min-height: clamp(17.5rem, 33svh, 18rem);')
    expect(css).not.toContain('.discover-spotlight__ambient { display: block; }')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) clamp(5.5rem, 22vw, 6.25rem);')
    expect(css).toContain('.discover-spotlight__copy { z-index: 2; grid-column: 1; grid-row: 1; display: flex;')
    expect(css).toContain('.discover-spotlight__poster {')
    expect(css).toContain('.discover-page .media-row--poster .cinematic-row-track > .media-row-card-slot')
    expect(css).toContain('.detail-page .episode-showcase-card { width: min(44vw, 15rem); }')
    expect(css).toContain('.detail-page .detail-hero-actions {')
    expect(css).toContain('flex-direction: column-reverse')
    expect(css).toContain('.cinematic-nav-capsule::-webkit-scrollbar { display: none; }')
    expect(css).toContain('.discover-page__heading h1')
    expect(css).toContain('.mobile-web-nav {')
    expect(css).toContain('env(safe-area-inset-bottom)')
    expect(css).toContain('font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;')
    expect(css).toContain('html[data-runtime-platform="web"] .media-row { margin-bottom: .35rem !important; }')
    expect(css).toContain('.catalog-page .media-grid {\n    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;')
    expect(css).toContain('.catalog-page__items {\n    display: grid !important;')
    expect(discoverSource).toContain('className="discover-page pb-12"')
    expect(discoverSource).toContain('const items = (isTopTen ? section.items : isPersonalGenre ? sortRecommendationsByPopularity(section.items) : section.items).map((entry) => entry.item).slice(0, isTopTen || isPersonalGenre ? 10 : undefined)')
    expect(discoverSource).toContain('const sourceCatalogItems = isPersonalGenre ? sortRecommendationsByPopularity(section.catalogItems ?? section.items) : section.catalogItems ?? section.items')
    expect(discoverSource).toContain('DiscoveryCalendarRow watchProgress={watchProgress}')
    expect(discoverSource).toContain('className="row-contain discover-shelf discover-shelf--personal-seed"')
    expect(discoverSource).toContain("section.id.startsWith('because-genre-')")
    expect(discoverSource).toContain('const catalogEntries = section.id === \'made-for-you\'\n        ? section.items.slice(0, 10)')
    expect(discoverSource).toContain('className="discover-spotlight discover-next-hero"')
    expect(discoverSource).toContain('Your Next Obsession')
    expect(discoverSource).toContain('<p className="discover-spotlight__eyebrow">Tonight</p>')
    expect(discoverSource).toContain('onClick={chooseAnotherSpotlight}')
    expect(discoverSource).not.toContain('className="discover-tonight row-contain"')
    expect(discoverSource).not.toContain('const chooseAnotherTonight = () =>')
    expect(discoverSource).toContain('title="How Much Time Tonight?"')
    expect(discoverSource).toContain('headerEyebrow="Picked to fit"')
    expect(discoverSource).toContain('className="discover-editorial-tabs" role="group" aria-label="Choose a watch duration"')
    expect(discoverSource).toContain('items={timeTonightItems}')
    expect(discoverSource).toContain('The spotlight is an extra editorial recommendation, not one of the')
    expect(discoverSource).toContain('title="Made for the Big Screen"')
    expect(discoverSource).toContain('title="Hidden Gems"')
    expect(discoverSource).toContain('title="New in Your Library"')
    expect(discoverSource).toContain('discover-shelf--big-screen')
    expect(discoverSource).toContain('discover-shelf--gems')
    expect(discoverSource).toContain('discover-shelf--recent')
    expect(discoverSource).toContain('More popular picks')
    expect(discoverSource).toContain('const currentTrendingRanked = useMemo(() => {')
    expect(discoverSource).toContain('return orderRecommendationsBySource(rankCandidates(')
    expect(discoverSource).toContain('if (!entry.item.poster || key === heroMediaKey || seen.has(key)) return false')
    expect(discoverSource).toContain('className="discover-spotlight__poster"')
    expect(discoverSource).toContain('getTrendingTmdb(contentType, \'week\')')
    expect(discoverSource).toContain("...currentTrending.map((item) => recommendationCandidate(item,'tmdb-trending'))")
    expect(discoverSource).toContain('discover-shelf--recent')
    expect(discoverSource).not.toContain('From Your Servers')
    expect(discoverSource).not.toContain('discover-libraries')
    expect(mobileNavigationSource).toContain('aria-label="Mobile navigation"')
  })

  it('keeps mobile web on compact static cards without exposing the desktop motion toggle', () => {
    const mediaCardSource = readFileSync(new URL('../MediaCard.tsx', import.meta.url), 'utf8')
    const mediaRowSource = readFileSync(new URL('../MediaRow.tsx', import.meta.url), 'utf8')
    const settingsSource = readFileSync(new URL('../../pages/SettingsPage.tsx', import.meta.url), 'utf8')
    expect(mediaCardSource).toContain('useAppStore((s) => s.homeCardAnimations) && !isMobileWebViewport()')
    expect(mediaRowSource).toContain('cinematicExpand={cinematicExpand && homeCardAnimations && !fixedHome && !isMobileWebViewport()}')
    expect(mediaRowSource).toContain('element.scrollLeft < maxScroll - 2')
    expect(settingsSource).toContain('{!mobileWeb && <SettingRow label="Card focus animations"')
  })

  it('removes invisible desktop expansion space and caps mobile show-all cards', () => {
    expect(css).toContain('[data-home-shelves] .media-row .cinematic-row-track')
    expect(css).toContain('padding-bottom: .4rem !important;')
    expect(css).toContain('.show-all-card[data-show-all-layout="ranked"]')
    expect(css).toContain('height: auto !important;')
  })
})
