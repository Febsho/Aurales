import { expect, test } from '@playwright/test'

test('the shared Aurales app starts from profile selection and remains usable at phone width', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toBeVisible()
  const profileButton = page.locator('button').filter({ hasText: 'Select profile' }).first()
  await expect(profileButton).toBeVisible()
  await profileButton.click()

  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)
  await expect(page.locator('main')).toBeVisible()
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }))
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport + 1)
  expect(pageErrors).toEqual([])
})

test('shared layouts remain navigable on tablet and TV-sized viewports', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.locator('main')).toBeVisible()

  for (const viewport of [{ width: 768, height: 1024 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport)
    const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
    await expect(navigation).toBeVisible()
    await expect(navigation.locator('a').first()).toBeVisible()
    await page.waitForFunction(() => {
      const links = document.querySelectorAll<HTMLElement>('nav[aria-label="Primary navigation"] a')
      return links.length > 0 && Array.from(links).every((link) => {
        const rect = link.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
    })

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
    }))
    expect(dimensions.page, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1)
    expect(dimensions.height).toBe(viewport.height)

    const settingsLink = navigation.getByRole('link', { name: 'Settings' })
    await settingsLink.evaluate((link: HTMLAnchorElement) => link.click())
    await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()
  }
})

test('browser cache settings describe IndexedDB and browser-managed artwork storage', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: /Advanced/ }).click()
  await expect(page.getByText('IndexedDB-backed cache for instant page loads.')).toBeVisible()
  await expect(page.getByText('Artwork uses the browser\'s HTTP cache. Its size and retention are controlled by the browser and cannot be measured or cleared by Aurales.')).toBeVisible()
  await expect(page.getByLabel('Image cache size limit')).toHaveCount(0)
  await expect(page.getByLabel('Image cache retention')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Clear Image Cache' })).toHaveCount(0)
})

test('mobile web always uses a bottom navigation with 44px touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aurales_navigation_style', 'topbar'))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)

  await expect(page.locator('.app-theme-shell')).toHaveAttribute('data-mobile-web', 'true')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' })
  await expect(navigation).toBeVisible()
  const targets = await navigation.locator('a').evaluateAll((links) => links.map((link) => {
    const rect = link.getBoundingClientRect()
    return { label: link.getAttribute('aria-label') || link.textContent?.trim(), width: rect.width, height: rect.height }
  }))
  expect(targets.length).toBeGreaterThan(1)
  expect(targets.every((target) => target.width >= 44 && target.height >= 44), JSON.stringify(targets)).toBe(true)
})

test('mobile web hides desktop navigation and Home hero layout preferences', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.locator('[data-home-card-motion]')).toHaveAttribute('data-home-card-motion', 'off')
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: /Interface/ }).click()
  await expect(page.getByLabel('Navigation style')).toHaveCount(0)
  await expect(page.getByLabel('Home hero layout')).toHaveCount(0)
  await expect(page.getByText('Card focus animations')).toHaveCount(0)
})

test('mobile Search uses compact system typography without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.getByRole('link', { name: 'Search' }).click()
  await expect(page.getByRole('heading', { name: 'Find your next story' })).toBeVisible()
  const layout = await page.evaluate(() => {
    const overview = document.querySelector<HTMLElement>('.search-overview')!
    const title = document.querySelector<HTMLElement>('.search-title')!
    const summary = document.querySelector<HTMLElement>('.search-summary')!
    const bounds = (element: HTMLElement) => element.getBoundingClientRect()
    return {
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
      overview: bounds(overview).toJSON(),
      title: bounds(title).toJSON(),
      summary: bounds(summary).toJSON(),
    }
  })
  expect(layout.document).toBeLessThanOrEqual(layout.viewport + 1)
  expect(layout.titleFontSize).toBeLessThanOrEqual(24)
  expect(layout.title.x).toBeGreaterThanOrEqual(0)
  expect(layout.title.right).toBeLessThanOrEqual(layout.viewport)
  expect(layout.summary.top).toBeGreaterThanOrEqual(layout.title.bottom - 1)
  expect(layout.overview.bottom).toBeGreaterThanOrEqual(layout.summary.bottom)
})

test('desktop web still honors the configured sidebar navigation', async ({ page }, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), 'A mobile device profile remains mobile even when its viewport is resized.')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(() => localStorage.setItem('aurales_navigation_style', 'sidebar'))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)
  await expect(page.locator('.app-theme-shell')).not.toHaveAttribute('data-mobile-web', 'true')
  await expect(page.locator('.app-theme-shell')).toHaveAttribute('data-nav-mode', 'sidebar-overlay')
  await page.getByRole('button', { name: /open navigation/i }).click()
  await page.mouse.move(1200, 760)
  await expect(page.locator('.app-sidebar__nav')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0)
  await page.locator('.app-sidebar__nav').getByRole('link', { name: 'Search' }).click()
  await expect(page).toHaveURL(/\/search$/)
})

test('fixed hero preference uses a swipeable mobile presentation and restores Fixed Focus on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aurales_home_hero_mode', 'fixed'))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()

  const home = page.locator('[data-home-presentation]')
  await expect(home).toHaveAttribute('data-home-presentation', 'dynamic')
  const emptyContinueState = home.locator('.cw-empty-state')
  await expect(emptyContinueState).toContainText('Nothing in progress')
  const emptyContinueBounds = await emptyContinueState.boundingBox()
  if (emptyContinueBounds) {
    expect(emptyContinueBounds.height, 'an empty Continue Watching shelf should not reserve four landscape cards').toBeLessThanOrEqual(72)
    expect(emptyContinueBounds.x + emptyContinueBounds.width).toBeLessThanOrEqual(391)
  } else {
    await expect(emptyContinueState).not.toBeVisible()
  }

  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(home).toHaveAttribute('data-home-presentation', 'fixed')
})

test('mobile Home keeps a real catalogue hero and poster shelf compact', async ({ page }) => {
  const profileId = 'mobile-layout-test'
  const profileRows = [
    {
      id: 'mobile-hero', title: 'Spotlight', layout: 'hero', enabled: true, order: 0, sourceType: 'discover',
      discoverConfig: { source: 'TMDB', contentType: 'movie', sortBy: 'popularity.desc', cacheTtl: 3600, releasedOnly: true, includeAdult: false, includeGenres: [], excludeGenres: [], genreMatchMode: 'OR', people: [], peopleMatchMode: 'OR', includeCompanies: [], excludeCompanies: [], companyMatchMode: 'OR', includeKeywords: [], excludeKeywords: [], keywordMatchMode: 'OR', watchRegion: 'US', providerMatchMode: 'OR', selectedProviders: [], voteAverageMin: 0, voteAverageMax: 10, voteCountMin: 0 },
    },
    { id: 'mobile-continue', title: 'Continue Watching', layout: 'continue', enabled: true, order: 1, sourceType: 'local' },
    { id: 'mobile-upcoming', title: 'Upcoming', layout: 'upcoming', enabled: true, order: 2, sourceType: 'local' },
    {
      id: 'mobile-posters', title: 'Mobile test shelf', layout: 'poster', enabled: true, order: 3, sourceType: 'discover',
      discoverConfig: { source: 'TMDB', contentType: 'movie', sortBy: 'popularity.desc', cacheTtl: 3600, releasedOnly: true, includeAdult: false, includeGenres: [], excludeGenres: [], genreMatchMode: 'OR', people: [], peopleMatchMode: 'OR', includeCompanies: [], excludeCompanies: [], companyMatchMode: 'OR', includeKeywords: [], excludeKeywords: [], keywordMatchMode: 'OR', watchRegion: 'US', providerMatchMode: 'OR', selectedProviders: [], voteAverageMin: 0, voteAverageMax: 10, voteCountMin: 0 },
    },
    {
      id: 'mobile-ranked', title: 'Mobile ranked shelf', layout: 'ranked', enabled: true, order: 4, sourceType: 'discover',
      discoverConfig: { source: 'TMDB', contentType: 'movie', sortBy: 'popularity.desc', cacheTtl: 3600, releasedOnly: true, includeAdult: false, includeGenres: [], excludeGenres: [], genreMatchMode: 'OR', people: [], peopleMatchMode: 'OR', includeCompanies: [], excludeCompanies: [], companyMatchMode: 'OR', includeKeywords: [], excludeKeywords: [], keywordMatchMode: 'OR', watchRegion: 'US', providerMatchMode: 'OR', selectedProviders: [], voteAverageMin: 0, voteAverageMax: 10, voteCountMin: 0 },
    },
  ]

  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(({ id, rows }) => {
    localStorage.setItem('aurales_profiles_v1', JSON.stringify([{ id, name: 'Mobile test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', isDefault: true }]))
    localStorage.setItem('aurales_active_profile_v1', id)
    localStorage.setItem('tmdb_api_key', 'playwright-public-test-key')
    localStorage.setItem('aurales_app_managed_metadata', 'false')
    localStorage.setItem(`aurales_home_rows:profile:${id}`, JSON.stringify(rows))
    localStorage.setItem(`aurales_home_hero_mode:profile:${id}`, 'dynamic')
  }, { id: profileId, rows: profileRows })

  await page.route('https://api.themoviedb.org/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/discover/movie') || pathname.endsWith('/discover/tv')) {
      await new Promise((resolve) => setTimeout(resolve, 350))
      const results = Array.from({ length: 28 }, (_, index) => ({
        id: 43125 + index,
        title: `Mobile Fixture Film ${index + 1}`,
        poster_path: '/mobile-fixture-poster.jpg',
        backdrop_path: '/mobile-fixture-backdrop.jpg',
        overview: 'A fixture for responsive Home layout verification.',
        release_date: '2025-05-01',
        vote_average: 8.2,
        vote_count: 4200,
        popularity: 220 - index,
        genre_ids: [18, 35, 53, 27, 80, 9648, 878, 10765, 10759, 10751, 10762, 14],
        original_language: 'en',
      }))
      await route.fulfill({ json: { page: 1, total_pages: 1, total_results: results.length, results } })
      return
    }
    await route.fulfill({ json: {} })
  })
  await page.route('https://image.tmdb.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 3"><rect width="2" height="3" fill="#222"/></svg>' }))

  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  const loadingPosterShelf = page.locator('[data-home-shelves] .home-row-skeleton[data-layout="poster"]').first()
  await expect(loadingPosterShelf).toBeVisible()
  const skeletonMeasurements = await loadingPosterShelf.evaluate((shelf) => {
    const track = shelf.querySelector<HTMLElement>('.home-row-skeleton-track')!
    const poster = shelf.querySelector<HTMLElement>('[data-home-skeleton-card]')!
    const art = poster.querySelector<HTMLElement>('[data-home-skeleton-art]')!
    return {
      gap: Number.parseFloat(getComputedStyle(track).gap),
      cardWidth: poster.getBoundingClientRect().width,
      artHeight: art.getBoundingClientRect().height,
    }
  })
  expect(skeletonMeasurements.gap).toBeLessThanOrEqual(8)
  expect(skeletonMeasurements.cardWidth).toBeGreaterThanOrEqual(100)
  expect(skeletonMeasurements.cardWidth).toBeLessThanOrEqual(124)
  expect(skeletonMeasurements.artHeight).toBeGreaterThan(0)

  const hero = page.locator('[data-home-presentation="dynamic"] [data-home-hero] > div:first-child')
  await expect(hero).toBeVisible()
  await expect.poll(
    () => hero.evaluate((element) => element.getBoundingClientRect().height),
    { message: 'catalogue hero should finish mounting with its responsive height' },
  ).toBeGreaterThan(0)
  const posterShelf = page.locator('[data-home-shelves] .media-row--poster .cinematic-row-track')
  await expect(posterShelf.locator('.media-row-card-slot').first()).toBeVisible()
  const rankedShelf = page.locator('[data-home-shelves] .media-row--ranked .cinematic-row-track')
  const rankedCard = rankedShelf.locator('.media-row-card-slot').first().locator('button')
  const rankedArt = rankedCard.locator('[data-hero-viewport]').first()
  await expect(rankedCard).toBeVisible()
  await expect(rankedArt).toBeVisible()
  await expect.poll(
    () => rankedArt.evaluate((art) => art.getBoundingClientRect().width),
    { message: 'the ranked poster artwork should finish applying its responsive width' },
  ).toBeGreaterThanOrEqual(100)
  await expect(page.locator('[data-home-shelves] .show-all-card')).toHaveCount(0)
  const firstShelfHeading = page.locator('[data-home-shelves] .media-row h2').first()
  await expect(firstShelfHeading).toBeVisible()
  await expect(firstShelfHeading.locator('xpath=..')).toHaveJSProperty('tagName', 'BUTTON')
  const continueEmpty = page.locator('[data-home-shelves] [data-home-row="continue-empty"]')
  const upcomingRow = page.locator('[data-home-shelves] [data-home-row="upcoming"]')
  await expect(continueEmpty.locator('.cw-empty-state')).toBeVisible()
  await expect(upcomingRow.locator('[data-home-upcoming-empty]')).toBeVisible()
  await expect.poll(
    () => hero.evaluate((element) => element.getBoundingClientRect().height),
    { message: 'the mobile catalogue hero should retain its responsive height after the shelves settle' },
  ).toBeGreaterThanOrEqual(520)

  const measurements = await page.evaluate(() => {
    const hero = document.querySelector<HTMLElement>('[data-home-presentation="dynamic"] [data-home-hero] > div:first-child')
    const track = document.querySelector<HTMLElement>('[data-home-shelves] .media-row--poster .cinematic-row-track')
    const poster = document.querySelector<HTMLElement>('[data-home-shelves] .media-row--poster .cinematic-row-track .media-row-card-slot')
    const posterHeader = poster?.closest('.media-row')?.querySelector<HTMLElement>(':scope > div:first-child')
    const continueEmpty = document.querySelector<HTMLElement>('[data-home-shelves] [data-home-row="continue-empty"]')
    const upcoming = document.querySelector<HTMLElement>('[data-home-shelves] [data-home-row="upcoming"]')
    const upcomingControls = upcoming?.querySelectorAll<HTMLButtonElement>('button[aria-label^="Scroll upcoming"]')
    return hero && track && poster && posterHeader && continueEmpty && upcoming && upcomingControls?.length === 2 ? {
      heroHeight: hero.getBoundingClientRect().height,
      compactHero: hero.hasAttribute('data-hero-compact'),
      hasCastRow: Boolean(hero.querySelector('.hero-content-overlay > div:has(> div.flex.-space-x-2)')),
      gap: Number.parseFloat(getComputedStyle(track).gap),
      posterWidth: poster.getBoundingClientRect().width,
      heroShelfGap: document.querySelector<HTMLElement>('[data-home-shelves]')!.getBoundingClientRect().top - hero.getBoundingClientRect().bottom,
      continueUpcomingGap: upcoming.getBoundingClientRect().top - continueEmpty.getBoundingClientRect().bottom,
      upcomingPosterHeadingGap: posterHeader.getBoundingClientRect().top - upcoming.getBoundingClientRect().bottom,
      shelfGaps: (() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-home-shelves] .media-row'))
        return rows.slice(0, -1).map((row, index) => rows[index + 1].getBoundingClientRect().top - row.getBoundingClientRect().bottom)
      })(),
      upcomingControlHeights: Array.from(upcomingControls, (button) => button.getBoundingClientRect().height),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    } : null
  })
  expect(measurements).not.toBeNull()
  expect(measurements!.heroHeight).toBeGreaterThan(0)
  expect(measurements!.heroHeight).toBeGreaterThanOrEqual(640)
  expect(measurements!.heroHeight).toBeLessThanOrEqual(900)
  expect(measurements!.compactHero).toBe(true)
  expect(measurements!.hasCastRow).toBe(false)
  expect(measurements!.gap).toBeLessThanOrEqual(8)
  expect(measurements!.posterWidth).toBeGreaterThan(0)
  expect(measurements!.posterWidth).toBeGreaterThanOrEqual(100)
  expect(measurements!.posterWidth).toBeLessThanOrEqual(124)
  const rankedMeasurements = await rankedArt.evaluate((art) => ({
    width: art.getBoundingClientRect().width,
    height: art.getBoundingClientRect().height,
  }))
  expect(rankedMeasurements.width, 'mobile ranked shelves should match the poster rail width').toBeGreaterThanOrEqual(100)
  expect(rankedMeasurements.width).toBeLessThanOrEqual(124)
  expect(rankedMeasurements.height, 'mobile ranked art should retain portrait poster proportions').toBeGreaterThanOrEqual(145)
  expect(rankedMeasurements.height).toBeLessThanOrEqual(190)
  expect(measurements!.heroShelfGap).toBeLessThanOrEqual(9)
  expect(measurements!.continueUpcomingGap).toBeLessThanOrEqual(21)
  expect(measurements!.upcomingPosterHeadingGap).toBeLessThanOrEqual(21)
  expect(measurements!.shelfGaps.every((gap) => gap <= 28), JSON.stringify(measurements!.shelfGaps)).toBe(true)
  expect(measurements!.upcomingControlHeights.every((height) => height >= 44)).toBe(true)
  expect(measurements!.horizontalOverflow).toBe(false)
})

test('mobile Discover and movie details keep text, hero and controls within the viewport', async ({ page }) => {
  test.setTimeout(90_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    localStorage.setItem('aurales_app_managed_metadata', 'false')
    localStorage.setItem('tmdb_api_key', 'playwright-public-test-key')
    if (location.pathname === '/movie/mobile-layout-fixture') {
      history.replaceState({
        usr: {
          title: 'A Long Mobile Fixture Title That Must Wrap Without Colliding',
          year: 2026,
          overview: 'A short fixture description used to verify that title, metadata, actions, and backdrop remain comfortably arranged on a phone screen.',
          rating: 8.2,
          poster: 'https://image.tmdb.org/t/p/w500/mobile-poster.jpg',
          backdrop: 'https://image.tmdb.org/t/p/original/mobile-backdrop.jpg',
        },
        key: 'mobile-layout-fixture',
        idx: 0,
      }, '', location.href)
    }
  })
  // Exercise the geometry fallback used when a browser delays an observer
  // delivery during nested scrolling. Infinite-scroll observers remain live.
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super((entries, observer) => {
          if (options?.rootMargin !== '0px 0px -32px 0px') callback(entries, observer)
        }, options)
      }
    } as typeof IntersectionObserver
  })
  const tmdbRequestPaths = new Set<string>()
  const runtimeFilterRequests: Array<{ path: string; min: string | null; max: string | null; language: string | null }> = []
  const continuationPages = new Set<number>()
  const animeContinuationResponses: string[] = []
  let animeMovieContinuationFailuresRemaining = 0
  await page.route('https://api.ids.moe/**', (route) => route.fulfill({ json: {} }))
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    tmdbRequestPaths.add(requestUrl.pathname)
    if (requestUrl.searchParams.has('with_runtime.gte') || requestUrl.searchParams.has('with_runtime.lte')) {
      runtimeFilterRequests.push({ path: requestUrl.pathname, min: requestUrl.searchParams.get('with_runtime.gte'), max: requestUrl.searchParams.get('with_runtime.lte'), language: requestUrl.searchParams.get('with_original_language') })
    }
    if (/^\/3\/trending\/(movie|tv)\/week$/.test(requestUrl.pathname)) {
      const weeklyType = requestUrl.pathname.includes('/movie/') ? 'movie' : 'series'
      const results = Array.from({ length: 8 }, (_, index) => ({
        id: 89000 + index,
        title: `Weekly trend ${index + 1}`,
        name: `Weekly trend ${index + 1}`,
        poster_path: `/weekly-trend-${index + 1}.jpg`,
        backdrop_path: '/weekly-trend-backdrop.jpg',
        overview: 'A current weekly-trending test title.',
        release_date: '2026-05-01',
        first_air_date: '2026-05-01',
        vote_average: 8.2,
        vote_count: 1800,
        popularity: 80 - index * 10,
        genre_ids: weeklyType === 'movie' ? [878, 14] : [18, 10759],
        original_language: 'en',
      }))
      await route.fulfill({ json: { page: 1, total_pages: 1, total_results: results.length, results } })
      return
    }
    if (requestUrl.searchParams.get('with_genres') === '28') {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await route.fulfill({ json: { page: 1, total_pages: 1, total_results: 0, results: [] } })
      return
    }
    const requestedPage = Number(requestUrl.searchParams.get('page') || 1)
    const isAnimeQuery = requestUrl.searchParams.get('with_original_language') === 'ja'
      && (requestUrl.searchParams.get('with_genres') || '').split(/[|,]/).includes('16')
    const animeMediaType = requestUrl.pathname.endsWith('/discover/movie') ? 'movie' : 'series'
    if (isAnimeQuery && requestedPage >= 4 && animeMovieContinuationFailuresRemaining > 0 && animeMediaType === 'movie') {
      animeMovieContinuationFailuresRemaining -= 1
      animeContinuationResponses.push('movie:4:failed')
      await route.fulfill({ status: 503, json: { status_message: 'Temporary test failure' } })
      return
    }
    if (isAnimeQuery && requestedPage >= 4) {
      animeContinuationResponses.push(`${animeMediaType}:${requestedPage}:ok`)
      const results = Array.from({ length: 8 }, (_, index) => ({
        id: (animeMediaType === 'movie' ? 87000 : 88000) + requestedPage * 10 + index,
        title: `Anime ${animeMediaType} continuation page ${requestedPage} title ${index + 1}`,
        name: `Anime ${animeMediaType} continuation page ${requestedPage} title ${index + 1}`,
        poster_path: '/anime-continuation-poster.jpg',
        release_date: '2026-05-01',
        first_air_date: '2026-05-01',
        vote_average: 8.1,
        vote_count: 900,
        popularity: 180 - index,
        genre_ids: [16, 18, 878],
        original_language: 'ja',
      }))
      await route.fulfill({ json: { page: requestedPage, total_pages: animeMediaType === 'series' ? 5 : 4, total_results: results.length, results } })
      return
    }
    const isUnfilteredMoviePage = requestUrl.pathname.endsWith('/discover/movie')
      && !requestUrl.searchParams.has('with_genres')
      && !requestUrl.searchParams.has('with_runtime.gte')
      && !requestUrl.searchParams.has('with_runtime.lte')
    if (isUnfilteredMoviePage) continuationPages.add(requestedPage)
    const results = isAnimeQuery
      ? Array.from({ length: 12 }, (_, index) => ({
        id: 86000 + requestedPage * 20 + index,
        title: `Anime discovery fixture ${requestedPage}-${index + 1}`,
        name: `Anime discovery fixture ${requestedPage}-${index + 1}`,
        poster_path: '/anime-discovery-fixture-poster.jpg',
        backdrop_path: '/anime-discovery-fixture-backdrop.jpg',
        overview: 'Japanese animation fixture for Discovery pagination.',
        first_air_date: '2026-05-01',
        release_date: '2026-05-01',
        vote_average: 8.2,
        vote_count: 1200,
        popularity: 160 - index,
        genre_ids: [16, 18, 878],
        original_language: 'ja',
      }))
      : requestedPage === 4 && isUnfilteredMoviePage
      ? Array.from({ length: 20 }, (_, index) => ({
        id: 83000 + index,
        title: `More discovery fixture ${index + 1}`,
        name: `More discovery fixture ${index + 1}`,
        poster_path: '/more-discovery-fixture-poster.jpg',
        backdrop_path: '/more-discovery-fixture-backdrop.jpg',
        overview: 'An additional popular title loaded by Discovery pagination.',
        release_date: '2026-05-01',
        vote_average: 7.8,
        vote_count: 900,
        popularity: 240 - index,
        genre_ids: [18, 35, 53, 27, 80, 9648, 878, 10765, 10759, 10751, 10762, 14],
        original_language: 'en',
      }))
      : requestedPage > 4 && isUnfilteredMoviePage ? [] : Array.from({ length: 40 }, (_, index) => ({
      id: 81000 + index,
      title: `Discovery fixture ${index + 1}`,
      name: `Discovery fixture ${index + 1}`,
      poster_path: '/discovery-fixture-poster.jpg',
      backdrop_path: '/discovery-fixture-backdrop.jpg',
      overview: 'A mocked recommendation used to check the Discovery spotlight and responsive shelves.',
      release_date: new Date().toISOString().slice(0, 10),
      first_air_date: new Date().toISOString().slice(0, 10),
      vote_average: 8.2,
      vote_count: 1200,
      popularity: 160 - index,
      genre_ids: [18, 35, 53, 27, 80, 9648, 878, 10765, 10759, 10751, 10762, 14],
      original_language: 'en',
    }))
    await route.fulfill({ json: { page: requestedPage, total_pages: isUnfilteredMoviePage ? 4 : 1, total_results: results.length, results } })
  })
  await page.route('https://image.tmdb.org/**', (route) => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 3"><rect width="2" height="3" fill="#777"/></svg>' }))

  await page.goto('/movie/mobile-layout-fixture')
  await page.getByRole('button', { name: /select profile/i }).click()
  const detail = page.locator('.detail-page--movie')
  await expect(detail).toBeVisible()
  await expect(page.locator('.profile-switch-transition')).toHaveCount(0)
  const detailLayout = await page.evaluate(() => {
    const hero = document.querySelector<HTMLElement>('.detail-page--movie .detail-hero-panel')
    const title = document.querySelector<HTMLElement>('.detail-page--movie .detail-hero-panel__title')
    const overview = document.querySelector<HTMLElement>('.detail-page--movie .detail-hero-overview')
    const actions = document.querySelector<HTMLElement>('.detail-page--movie .detail-hero-actions')
    const nav = document.querySelector<HTMLElement>('.mobile-web-nav')
    if (!hero || !title || !overview || !actions || !nav) return null
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect()
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
    }
    const visualTitle = hero.querySelector<HTMLElement>('.detail-hero-panel__logo, .detail-hero-panel__title')
    return {
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      hero: rect(hero), title: rect(title), visualTitle: visualTitle ? rect(visualTitle) : null,
      classification: rect(hero.querySelector<HTMLElement>('.detail-hero-classification')!),
      overview: rect(overview), actions: rect(actions), nav: rect(nav),
      actionLayout: getComputedStyle(actions).display,
      episodeCardWidth: (() => {
        const card = document.createElement('button')
        card.className = 'episode-showcase-card'
        document.querySelector('.detail-page')?.append(card)
        const width = card.getBoundingClientRect().width
        card.remove()
        return width
      })(),
    }
  })
  expect(detailLayout).not.toBeNull()
  expect(detailLayout!.document).toBeLessThanOrEqual(detailLayout!.viewport + 1)
  expect(detailLayout!.hero.height).toBeLessThanOrEqual(600)
  for (const element of [detailLayout!.title, detailLayout!.overview, detailLayout!.actions]) {
    expect(element.left).toBeGreaterThanOrEqual(-1)
    expect(element.right).toBeLessThanOrEqual(detailLayout!.viewport + 1)
  }
  expect(detailLayout!.overview.top).toBeGreaterThanOrEqual(detailLayout!.title.bottom - 1)
  expect(detailLayout!.actions.top).toBeGreaterThanOrEqual(detailLayout!.overview.bottom - 1)
  for (const element of [detailLayout!.visualTitle, detailLayout!.classification, detailLayout!.overview, detailLayout!.actions]) {
    expect(Math.abs((element.left + element.right) / 2 - detailLayout!.viewport / 2), 'mobile detail hero content should be centered').toBeLessThanOrEqual(12)
  }
  expect(detailLayout!.nav.bottom).toBeLessThanOrEqual(845)
  expect(detailLayout!.actionLayout).toBe('flex')
  expect(detailLayout!.episodeCardWidth).toBeLessThanOrEqual(390 * .5)

  await page.evaluate(() => {
    const profileId = localStorage.getItem('aurales_active_profile_v1') || 'default'
    const key = `aurales_local_watchlist_v1:profile:${profileId}`
    const value = JSON.stringify([{ id: 'library-fixture-1', title: 'Recently Added Library Fixture', type: 'movie', provider: 'local', addedAt: Date.now(), poster: 'https://image.tmdb.org/t/p/w500/library-fixture-poster.jpg', tmdbId: 81999, year: 2026 }])
    localStorage.setItem(key, value)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
  })

  await page.getByRole('link', { name: 'Discover' }).click()
  await expect(page.locator('.discover-page')).toBeVisible()
  const contentTypeControls = page.getByRole('group', { name: 'Content type' })
  await expect(contentTypeControls.getByRole('button', { name: 'Movies' })).toHaveAttribute('aria-pressed', 'true')
  await expect(contentTypeControls.getByRole('button', { name: 'Series' })).toHaveAttribute('aria-pressed', 'false')
  await expect(contentTypeControls.getByRole('button', { name: 'Anime' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => tmdbRequestPaths.has('/3/trending/movie/week')).toBe(true)
  await expect(page.getByRole('heading', { name: /Settle in,/ })).toBeVisible()
  const heroSpotlight = page.locator('.discover-next-hero')
  const obsessionCard = heroSpotlight
  await expect(heroSpotlight.locator('.discover-spotlight__eyebrow')).toContainText('Tonight')
  await expect(heroSpotlight.locator('.discover-spotlight__ambient img')).toHaveAttribute('src', /weekly-trend-backdrop/)
  await expect(page.locator('.discover-libraries')).toHaveCount(0)
  await expect(page.locator('.discover-shelf--favorites, .discover-shelf--new-library')).toHaveCount(0)
  const calendar = page.locator('.discover-calendar')
  await expect(calendar.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible()
  const calendarTop = (await calendar.boundingBox())!.y
  if (await calendar.locator('.discover-calendar__item').count() > 0) {
    await expect(calendar.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false')
    await expect(calendar.getByRole('button', { name: 'Next 30 days' })).toHaveAttribute('aria-pressed', 'true')
  } else {
    await expect(calendar).toHaveClass(/discover-calendar--empty/)
    await expect(calendar.getByRole('button', { name: 'Open calendar' })).toBeVisible()
    expect((await calendar.boundingBox())!.height, 'an empty calendar should not push the mobile spotlight down').toBeLessThanOrEqual(52)
  }
  await expect(page.getByRole('heading', { name: 'Continue Watching', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your Next Obsession' })).toBeVisible()
  const obsessionLayout = await heroSpotlight.evaluate((card) => {
    const poster = card.querySelector<HTMLElement>('.discover-spotlight__poster')!.getBoundingClientRect()
    const copy = card.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
    return { viewport: document.documentElement.clientWidth, card: card.getBoundingClientRect().toJSON(), poster: poster.toJSON(), copy: copy.toJSON() }
  })
  expect(obsessionLayout.card.left, 'the editorial pick should align with the mobile page gutter').toBeGreaterThanOrEqual(12)
  expect(obsessionLayout.poster.width, 'the editorial poster should remain visible in the mobile spotlight').toBeGreaterThanOrEqual(84)
  expect(obsessionLayout.poster.width).toBeLessThanOrEqual(124)
  expect(obsessionLayout.poster.right).toBeLessThanOrEqual(obsessionLayout.card.right - 10)
  expect(obsessionLayout.copy.right).toBeLessThanOrEqual(obsessionLayout.card.right - 8)
  const editorialPoster = heroSpotlight.locator('.discover-spotlight__poster img')
  await expect(editorialPoster).toHaveAttribute('data-artwork-loaded', 'true')
  await expect(editorialPoster).toHaveCSS('opacity', '1')
  const heroBackdrop = heroSpotlight.locator('.discover-spotlight__ambient img')
  await expect(heroBackdrop).toHaveClass(/is-loaded/)
  await expect(heroBackdrop).toHaveCSS('opacity', '1')
  await expect(page.getByRole('heading', { name: 'OR TRY', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Top 10 For You', exact: true })).toBeVisible()
  const mobileDiscoveryLayout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return null
      const { y, height } = element.getBoundingClientRect()
      return { y, height }
    }
    const headingRect = (label: string) => {
      const element = [...document.querySelectorAll<HTMLElement>('.discover-shelf h2')]
        .find((heading) => heading.textContent?.trim() === label)
      if (!element) return null
      const { y, height } = element.getBoundingClientRect()
      return { y, height }
    }
    return {
      profileWelcomeHeading: rect('.discover-page__heading h1'),
      browseControls: rect('.discover-page__tabs'),
      obsessionHeading: rect('#discover-next-title'),
      weekendCard: rect('.discover-next-hero'),
      trendingHeading: headingRect('OR TRY'),
      topTenHeading: headingRect('Top 10 For You'),
    }
  })
  const { profileWelcomeHeading, browseControls, obsessionHeading, weekendCard, trendingHeading, topTenHeading } = mobileDiscoveryLayout
  expect(Object.values(mobileDiscoveryLayout).every(Boolean), 'all major Discovery sections should have layout boxes').toBe(true)
  const obsessionTop = obsessionHeading!.y
  const trendingTop = trendingHeading!.y
  const topTenTop = topTenHeading!.y
  expect(calendarTop).toBeLessThan(obsessionTop)
  expect(obsessionTop).toBeLessThan(trendingTop)
  expect(trendingTop).toBeLessThan(topTenTop)
  await expect(page.getByRole('heading', { name: 'New in Your Library', exact: true })).toHaveCount(0)
  await expect(heroSpotlight.getByRole('button', { name: 'Details' })).toBeVisible()
  const firstSpotlightTitle = await obsessionCard.getAttribute('data-title')
  expect(firstSpotlightTitle).not.toBeNull()
  const editorialTopTenShelf = page.locator('.discover-shelf').filter({ has: page.getByRole('heading', { name: 'Top 10 For You', exact: true }) })
  await expect(page.locator('.discover-shelf--trending').getByText(firstSpotlightTitle!, { exact: true })).toHaveCount(0)
  await expect(editorialTopTenShelf.getByText(firstSpotlightTitle!, { exact: true })).toHaveCount(0)
  const promotedTrendTitles = await editorialTopTenShelf.locator('img').evaluateAll((images) => images.map((image) => image.getAttribute('alt') || '').filter((title) => /^Weekly trend \d+$/.test(title)))
  expect(promotedTrendTitles.length, 'Top 10 should include fresh weekly trends while keeping the editorial Spotlight separate').toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Not for me' }).click()
  await expect(page.locator('.discover-picker')).toHaveCount(0)
  const discoverySettings = page.getByRole('button', { name: 'Discovery settings' })
  await discoverySettings.evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('dialog', { name: 'Discovery settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Discovery settings' })).toHaveCount(0)
  await expect(discoverySettings).toBeFocused()
  await expect(page.locator('.discover-spotlight-heading').getByText('A movie for tonight').first()).toBeVisible()
  expect(profileWelcomeHeading!.y + profileWelcomeHeading!.height).toBeLessThan(browseControls!.y)
  expect(obsessionHeading!.y).toBeGreaterThan(browseControls!.y)
  expect(obsessionHeading!.y + obsessionHeading!.height).toBeLessThan(weekendCard!.y)
  await expect(page.getByRole('heading', { name: 'Trending Now', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Top 10 For You', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Drama Picks', exact: true })).toHaveCount(0)
  await expect(page.locator('.discover-shelf--personal-genre')).toHaveCount(0)
  await expect(page.locator('.discover-shelf--big-screen')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Best in Widescreen' })).toBeVisible()
  await expect(page.locator('.discover-shelf--gems, .discover-shelf--recent, .discover-shelf--top-rated')).toHaveCount(0)
  await expect.poll(() => tmdbRequestPaths.has('/3/discover/tv')).toBe(true)
  await expect(page.getByRole('heading', { name: 'Your Next Binge', exact: true })).toBeVisible()
  await expect.poll(() => tmdbRequestPaths.has('/3/trending/tv/week')).toBe(true)
  await expect(page.locator('.discover-binge__gallery .discover-binge__main-poster')).toBeVisible()
  await expect(page.locator('.discover-binge__main-poster img')).toHaveAttribute('alt', 'Weekly trend 1 poster')
  const topTenRow = page.locator('.discover-page .media-row--ranked').filter({ has: page.getByRole('heading', { name: 'Top 10 For You', exact: true }) })
  await expect(topTenRow.locator('.media-row-card-slot')).toHaveCount(10)
  await expect(topTenRow.locator('.show-all-card')).toHaveCount(0)
  await expect(topTenRow.locator('.media-rank__value').first()).toHaveText('1')
  await expect(topTenRow.locator('.media-rank__value').nth(1)).toHaveText('2')
  await expect(page.getByRole('heading', { name: 'OR TRY', exact: true })).toBeVisible()
  const trendingShelf = page.locator('.discover-shelf--trending')
  await expect.poll(async () => (await trendingShelf.locator('.media-row-card-slot img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')))).filter((title) => /^Weekly trend \d+$/.test(title || '')).length).toBeGreaterThan(0)
  await expect(page.locator('.discover-next-hero')).toHaveAttribute('data-title', /^Weekly trend \d+$/)
  const heroTitle = await page.locator('.discover-next-hero').getAttribute('data-title')
  const weeklyTrendOrder = await trendingShelf.locator('.media-row-card-slot img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')))
  const weeklyTrendTitles = weeklyTrendOrder.filter((title): title is string => /^Weekly trend \d+$/.test(title || ''))
  const weeklyTrendPositions = weeklyTrendTitles.map((title) => Number(title.match(/\d+/)?.[0]))
  expect(weeklyTrendTitles.length).toBeGreaterThan(0)
  expect(weeklyTrendTitles).not.toContain(heroTitle)
  expect(new Set(weeklyTrendTitles).size).toBe(weeklyTrendTitles.length)
  expect(weeklyTrendPositions).toEqual([...weeklyTrendPositions].sort((left, right) => left - right))
  await trendingShelf.scrollIntoViewIfNeeded()
  await expect.poll(() => trendingShelf.evaluate((element) => element.parentElement?.getAttribute('data-revealed'))).toBe('true')
  await expect.poll(() => trendingShelf.locator('.media-row-card-slot').first().evaluate((card) => getComputedStyle(card).animationName)).toBe('discover-card-arrive')
  const loadedPoster = trendingShelf.locator('.media-row-card-slot').first().locator('img.media-card-artwork')
  await expect(loadedPoster).toHaveAttribute('data-artwork-loaded', 'true')
  await expect(loadedPoster).toHaveCSS('opacity', '1')
  const loadedPosterMotion = await loadedPoster.evaluate((image) => ({
    opacity: getComputedStyle(image).opacity,
    transitionProperty: getComputedStyle(image).transitionProperty,
    transitionDuration: getComputedStyle(image).transitionDuration,
  }))
  expect(loadedPosterMotion.opacity).toBe('1')
  expect(loadedPosterMotion.transitionProperty).toContain('opacity')
  expect(loadedPosterMotion.transitionProperty).toContain('transform')
  expect(parseFloat(loadedPosterMotion.transitionDuration)).toBeGreaterThan(0)
  const trendingRail = trendingShelf.locator('.media-row > div.overflow-x-auto')
  const rightArrow = trendingShelf.getByRole('button', { name: 'Scroll right' })
  for (let pageIndex = 0; pageIndex < 8 && await rightArrow.isEnabled(); pageIndex += 1) {
    await rightArrow.click()
    await page.waitForTimeout(500)
    const bounds = await trendingRail.evaluate((rail) => ({ left: rail.scrollLeft, max: rail.scrollWidth - rail.clientWidth }))
    expect(bounds.left).toBeLessThanOrEqual(bounds.max + 1)
  }
  await expect(rightArrow).toBeDisabled()
  const finalRailBounds = await trendingRail.evaluate((rail) => ({ left: rail.scrollLeft, max: rail.scrollWidth - rail.clientWidth }))
  expect(finalRailBounds.max - finalRailBounds.left).toBeLessThanOrEqual(2)
  const mobileCardMotion = await trendingShelf.locator('.media-row-card-slot > button').first().evaluate((card) => ({
    transform: getComputedStyle(card).transform,
    transitionDuration: getComputedStyle(card).transitionDuration,
  }))
  expect(mobileCardMotion.transform).toBe('none')
  expect(parseFloat(mobileCardMotion.transitionDuration)).toBeGreaterThan(0)
  const recommendedShelf = page.locator('.discover-shelf').filter({ has: page.getByRole('heading', { name: 'Top 10 For You', exact: true }) })
  await recommendedShelf.getByRole('button', { name: 'Open Top 10 For You catalog' }).click()
  const recommendedCatalog = page.locator('.catalog-page')
  await expect(recommendedCatalog.getByRole('heading', { name: 'Top 10 For You', exact: true })).toBeVisible()
  const loadedCountText = await recommendedCatalog.getByText(/^\d+ titles loaded$/).textContent()
  const loadedCount = Number.parseInt(loadedCountText || '', 10)
  expect(loadedCount, 'the Top 10 title should open exactly its ten featured picks').toBe(10)
  const catalogCards = recommendedCatalog.locator('button:has(img)')
  await expect(catalogCards).toHaveCount(loadedCount)
  const dismissedTitlePresent = await catalogCards.evaluateAll((cards, title) => cards.some((card) => card.querySelector('img')?.alt === title), firstSpotlightTitle)
  expect(dismissedTitlePresent, 'Not for me should remove the dismissed title from the complete catalog').toBe(false)
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Settle in,/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your Next Obsession' })).toBeVisible()
  const trendingRailOrder = await page.evaluate(() => {
    const trend = Array.from(document.querySelectorAll<HTMLElement>('.discover-shelf h2')).find((heading) => heading.textContent?.trim() === 'OR TRY')
    const obsession = document.querySelector<HTMLElement>('.discover-next-hero')
    const topTen = Array.from(document.querySelectorAll<HTMLElement>('.discover-shelf h2')).find((heading) => heading.textContent?.trim() === 'Top 10 For You')
    return Boolean(trend && topTen && obsession
      && (obsession.compareDocumentPosition(trend) & Node.DOCUMENT_POSITION_FOLLOWING)
      && (trend.compareDocumentPosition(topTen) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  expect(trendingRailOrder, 'the independent editorial pick should lead into OR TRY and Top 10').toBe(true)
  const pickerBeforeShelves = await page.evaluate(() => {
    const picker = document.querySelector('#discover-refine-title')
    const topTen = Array.from(document.querySelectorAll('.discover-shelf h2')).find((heading) => heading.textContent?.trim() === 'Top 10 For You')
    return Boolean(picker && topTen && (topTen.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  expect(pickerBeforeShelves, 'the broad public recommendations should lead into the taste picker').toBe(true)
  await expect(page.getByRole('heading', { name: 'Your Genres' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Moods for Tonight' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Pick by Colour' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'How Much Time Tonight?' })).toBeVisible()
  const timeOptions = page.getByRole('group', { name: 'Choose film runtime' })
  await expect(timeOptions.getByRole('button', { name: 'About 2 Hours' })).toHaveAttribute('aria-pressed', 'true')
  await timeOptions.getByRole('button', { name: 'Under 90 Minutes' }).click()
  await expect(timeOptions.getByRole('button', { name: 'Under 90 Minutes' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => runtimeFilterRequests.some((request) => request.path.endsWith('/discover/movie') && request.max === '90')).toBe(true)
  await expect(page.getByRole('heading', { name: 'Under 90 Minutes Picks' })).toBeVisible()
  await contentTypeControls.getByRole('button', { name: 'Series' }).click()
  const seriesTimeOptions = page.getByRole('group', { name: 'Choose episode runtime' })
  await expect(seriesTimeOptions.getByRole('button', { name: 'Short Episodes' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => runtimeFilterRequests.some((request) => request.path.endsWith('/discover/tv') && request.max === '30')).toBe(true)
  await contentTypeControls.getByRole('button', { name: 'Anime' }).click()
  await expect(page.locator('.discover-next-hero .discover-spotlight__meta')).toContainText('Anime')
  const animeTimeOptions = page.getByRole('group', { name: 'Choose episode runtime' })
  await expect(animeTimeOptions.getByRole('button', { name: 'Short Episodes' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => runtimeFilterRequests.some((request) => request.path.endsWith('/discover/tv') && request.max === '25' && request.language === 'ja')).toBe(true)
  await contentTypeControls.getByRole('button', { name: 'Movies' }).click()
  const monoPosters = page.getByRole('button', { name: 'Mono', exact: true })
  await expect(monoPosters).toBeVisible()
  await monoPosters.click()
  await expect(monoPosters).toHaveAttribute('aria-pressed', 'true')
  const discoveryFlow = await page.locator('.discover-page').evaluate((root) => {
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h2, h3')).map((heading) => heading.textContent?.trim() || '')
    const referenceOrder = ['Your Genres', 'Your Next Binge', 'Sunday Night Moods', 'Pick by Colour', 'How Much Time Tonight?']
    return referenceOrder.filter((title) => headings.includes(title)).map((title) => headings.indexOf(title))
  })
  expect(discoveryFlow.every((position, index) => index === 0 || position > discoveryFlow[index - 1]!), 'Discovery sections should follow the reference flow from genres through mood and colour picks').toBe(true)
  await expect(page.locator('.discover-taste-pick')).toHaveCount(10)
  await expect(page.getByText(/Daily picks\s*·\s*US\s*·\s*6\+ rating/i)).toHaveCount(0)
  const mobileTabLayout = await page.locator('.discover-page__tabs button').evaluateAll((buttons) => buttons.map((button) => {
    const element = button as HTMLElement
    const bounds = element.getBoundingClientRect()
    return { left: bounds.left, right: bounds.right, width: bounds.width, textWidth: element.scrollWidth }
  }))
  expect(mobileTabLayout).toHaveLength(3)
  for (const [index, button] of mobileTabLayout.entries()) {
    expect(button.width).toBeGreaterThan(48)
    expect(button.textWidth).toBeLessThanOrEqual(button.width + 1)
    if (index > 0) expect(button.left).toBeGreaterThanOrEqual(mobileTabLayout[index - 1]!.right - 1)
  }
  const mobilePosterSpacing = await page.locator('.discover-shelf--trending .media-row--poster').evaluate((row) => {
    const cards = Array.from(row.querySelectorAll<HTMLElement>('.media-row-card-slot'))
    if (cards.length < 2) return null
    const first = cards[0]!.getBoundingClientRect()
    const second = cards[1]!.getBoundingClientRect()
    return { firstRight: first.right, secondLeft: second.left, firstWidth: first.width, firstHeight: first.height }
  })
  expect(mobilePosterSpacing).not.toBeNull()
  expect(mobilePosterSpacing!.secondLeft).toBeGreaterThanOrEqual(mobilePosterSpacing!.firstRight)
  expect(mobilePosterSpacing!.firstWidth).toBeGreaterThanOrEqual(80)
  expect(mobilePosterSpacing!.firstWidth).toBeLessThanOrEqual(100)
  expect(mobilePosterSpacing!.firstHeight).toBeLessThanOrEqual(mobilePosterSpacing!.firstWidth * 2.4)
  const mobileTasteGrid = await page.locator('.discover-taste-picks').evaluate((grid) => {
    const cards = Array.from(grid.querySelectorAll<HTMLElement>('.discover-taste-pick'))
    const first = cards[0]!.getBoundingClientRect()
    const second = cards[1]!.getBoundingClientRect()
    const poster = cards[0]!.querySelector<HTMLElement>('.discover-taste-pick__poster')!.getBoundingClientRect()
    return {
      rows: getComputedStyle(grid).gridTemplateRows.split(' ').length,
      clientWidth: grid.clientWidth,
      scrollWidth: grid.scrollWidth,
      cardWidth: first.width,
      firstColumnMatches: Math.abs(first.left - second.left) < 1,
      secondBelowFirst: second.top > first.top,
      posterWidth: poster.width,
    }
  })
  expect(mobileTasteGrid.rows).toBe(2)
  expect(mobileTasteGrid.firstColumnMatches).toBe(true)
  expect(mobileTasteGrid.secondBelowFirst).toBe(true)
  expect(mobileTasteGrid.scrollWidth).toBeGreaterThan(mobileTasteGrid.clientWidth)
  expect(mobileTasteGrid.cardWidth).toBeLessThanOrEqual(90)
  expect(mobileTasteGrid.posterWidth).toBeGreaterThan(0)
  await page.locator('.discover-taste-picks').evaluate((grid) => { grid.scrollLeft = 100 })
  await expect.poll(() => page.locator('.discover-taste-picks').evaluate((grid) => grid.scrollLeft)).toBeGreaterThan(0)

  await page.locator('.discover-genres__grid button').filter({ hasText: 'Drama' }).first().click()
  await expect(page.locator('#discover-genre-picks').getByRole('button', { name: 'Open Drama Picks catalog' })).toBeVisible()
  await expect.poll(() => page.locator('#discover-genre-picks .media-row-card-slot').count()).toBeGreaterThan(0)
  await page.locator('.discover-genres__grid button').filter({ hasText: 'Action' }).first().click()
  await expect(page.locator('#discover-genre-picks [role="status"]')).toContainText('Finding Action titles')
  await expect(page.getByText(/no titles found for action yet/i)).toBeVisible()
  await expect(page.locator('#discover-genre-picks .media-row-card-slot')).toHaveCount(0)

  const surpriseButton = page.getByRole('button', { name: /surprise me/i })
  await expect(surpriseButton).toBeEnabled()
  const startingTitle = await obsessionCard.getAttribute('data-title')
  const startingHeroTitle = await heroSpotlight.getAttribute('data-title')
  await page.evaluate(() => {
    const target = window as Window & { __auralesOriginalRandom?: () => number }
    target.__auralesOriginalRandom = Math.random
    Math.random = () => 0
  })
  // Trigger in-page because a real Playwright click waits for smooth-scroll completion,
  // which is longer than the roulette and can miss the transient busy state.
  await surpriseButton.evaluate((button: HTMLButtonElement) => button.click())
  expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches), 'roulette test should run with motion enabled').toBe(false)
  const pickerDialog = page.locator('.discover-picker[role="dialog"]')
  await expect(pickerDialog).toBeVisible()
  const pickerPosterFrame = await pickerDialog.locator('.discover-picker__poster').elementHandle()
  const pickerPosterImage = await pickerDialog.locator('.discover-picker__poster > img').elementHandle()
  await expect(pickerDialog).toHaveAttribute('aria-busy', 'true')
  await expect(pickerDialog.getByRole('status')).toHaveText('Finding something for you')
  await expect(pickerDialog.locator('.discover-picker__open')).toHaveCSS('visibility', 'hidden', { timeout: 500 })
  const mobileRouletteLayout = await pickerDialog.locator('.discover-picker__visual').evaluate((visual) => {
    const poster = visual.querySelector<HTMLElement>('.discover-picker__poster')!.getBoundingClientRect()
    const status = visual.querySelector<HTMLElement>('.discover-picker__status')!.getBoundingClientRect()
    return { viewport: document.documentElement.clientWidth, poster: poster.toJSON(), status: status.toJSON() }
  })
  expect(mobileRouletteLayout.poster.left).toBeGreaterThanOrEqual(0)
  expect(mobileRouletteLayout.poster.right).toBeLessThanOrEqual(mobileRouletteLayout.viewport)
  expect(mobileRouletteLayout.status.top).toBeGreaterThanOrEqual(mobileRouletteLayout.poster.bottom - 1)
  await expect.poll(() => pickerDialog.locator('.discover-picker__poster').evaluate((poster) => getComputedStyle(poster).animationName)).toBe('discover-picker-rolling')
  await expect.poll(() => pickerDialog.locator('.discover-picker__poster > img').evaluate((image) => image.getAnimations().some((animation) => animation.playState === 'running'))).toBe(true)
  await expect(surpriseButton).toHaveAttribute('aria-busy', 'false', { timeout: 5000 })
  await expect(pickerDialog.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  await expect(pickerDialog.getByRole('button', { name: 'Spin again', exact: true })).toBeVisible()
  expect(await pickerPosterFrame?.evaluate((poster) => poster.isConnected), 'roulette frames should keep the poster surface mounted').toBe(true)
  expect(await pickerPosterImage?.evaluate((image) => image.isConnected), 'roulette frames should update one poster image instead of stacking transitions').toBe(true)
  await expect(pickerDialog.locator('.discover-picker__poster > img')).toHaveCount(1)
  const firstPickerTitle = await pickerDialog.locator('.discover-picker__copy').getAttribute('data-title')
  expect(firstPickerTitle).not.toBe(startingTitle)
  expect(firstPickerTitle, 'Surprise Me should draw from current weekly trends before a stale daily snapshot').toMatch(/^Weekly trend \d+$/)
  await page.evaluate(() => {
    const target = window as Window & { __auralesOriginalRandom?: () => number }
    if (target.__auralesOriginalRandom) Math.random = target.__auralesOriginalRandom
    delete target.__auralesOriginalRandom
  })
  await expect(obsessionCard).toHaveAttribute('data-title', startingTitle!)
  await expect(heroSpotlight).toHaveAttribute('data-title', startingHeroTitle!)
  await expect(surpriseButton).toBeEnabled()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reducedMotionTitle = await pickerDialog.locator('.discover-picker__copy').getAttribute('data-title')
  await surpriseButton.evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => pickerDialog.locator('.discover-picker__copy').getAttribute('data-title')).not.toBe(reducedMotionTitle)
  const modalPickerTitle = await pickerDialog.locator('.discover-picker__copy').getAttribute('data-title')
  await pickerDialog.getByRole('button', { name: 'Spin again', exact: true }).click()
  await expect.poll(() => pickerDialog.locator('.discover-picker__copy').getAttribute('data-title')).not.toBe(modalPickerTitle)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.keyboard.press('Escape')
  await expect(page.locator('.discover-picker-backdrop')).toHaveClass(/is-closing/)
  await expect(pickerDialog).toHaveCount(0)
  await expect(surpriseButton).toBeFocused()
  await expect(heroSpotlight).toHaveAttribute('data-title', startingHeroTitle!)
  await expect(obsessionCard).toHaveAttribute('data-title', startingTitle!)
  await surpriseButton.evaluate((button: HTMLButtonElement) => button.click())
  await expect(pickerDialog).toBeVisible()
  const dismissedTitle = await pickerDialog.locator('.discover-picker__copy').getAttribute('data-title')
  await pickerDialog.getByRole('button', { name: /Not for me/i }).click()
  expect(dismissedTitle).not.toBe(startingTitle)
  await expect(pickerDialog).toHaveCount(0)
  await surpriseButton.evaluate((button: HTMLButtonElement) => button.click())
  await expect(pickerDialog).toBeVisible()
  await pickerDialog.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.locator('.detail-page')).toBeVisible()
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  await page.getByRole('button', { name: 'Play', exact: false }).first().click()
  await expect(page.locator('.detail-page')).toBeVisible()
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  const tastePick = page.locator('.discover-taste-pick').first()
  await expect(tastePick).toBeVisible()
  await tastePick.click()
  await expect(page.locator('.discover-refine__progress')).toHaveAttribute('aria-label', '1 of 3 titles selected')
  const tasteSearch = page.getByRole('searchbox', { name: 'Search titles to refine recommendations' })
  const searchableTitle = await page.locator('.discover-taste-pick__title').first().textContent()
  await tasteSearch.fill(searchableTitle || '')
  await expect(tasteSearch).toHaveValue(searchableTitle || '')
  await expect(page.locator('.discover-taste-pick').first()).toBeVisible()
  const filteredTasteTitles = await page.locator('.discover-taste-pick__title').allTextContents()
  expect(filteredTasteTitles.every((title) => title.toLocaleLowerCase().includes((searchableTitle || '').trim().toLocaleLowerCase()))).toBe(true)
  await tasteSearch.fill('')
  await page.getByRole('button', { name: /start over/i }).click()
  await expect(page.locator('.discover-refine__progress')).toHaveAttribute('aria-label', '0 of 3 titles selected')
  await expect(page.locator('.discover-taste-pick')).toHaveCount(10)
  await page.getByRole('button', { name: 'Series', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your Next Binge' })).toBeVisible()
  const moods = page.locator('.discover-moods')
  await expect(moods.getByRole('heading', { name: 'Sunday Night Moods' })).toBeVisible()
  await expect(moods.locator('.discover-moods__options button')).toHaveCount(3)
  await expect(moods.locator('.discover-moods__options button').first()).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => moods.locator('.media-row-card-slot').count()).toBeGreaterThan(0)
  await moods.getByRole('button', { name: 'Edge of Your Seat' }).click()
  await expect(moods.getByRole('button', { name: 'Edge of Your Seat', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => moods.locator('.media-row-card-slot').count()).toBeGreaterThan(0)
  await expect(page.locator('.discover-binge__main-poster')).toBeVisible()
  await expect(page.locator('.discover-binge__alternatives button')).toHaveCount(4)
  await page.locator('.discover-binge').scrollIntoViewIfNeeded()
  await expect.poll(() => page.locator('.discover-binge').evaluate((element) => element.parentElement?.getAttribute('data-revealed'))).toBe('true')
  const bingeGalleryLayout = await page.locator('.discover-binge__gallery').evaluate((gallery) => {
    const main = gallery.querySelector<HTMLElement>('.discover-binge__main-poster')!.getBoundingClientRect()
    const alternatives = gallery.querySelector<HTMLElement>('.discover-binge__alternatives')!.getBoundingClientRect()
    return { mainLeft: main.left, mainRight: main.right, alternativesLeft: alternatives.left, alternativesRight: alternatives.right, galleryRight: gallery.getBoundingClientRect().right }
  })
  expect(bingeGalleryLayout.mainLeft).toBeGreaterThanOrEqual(0)
  expect(bingeGalleryLayout.mainRight).toBeLessThanOrEqual(bingeGalleryLayout.alternativesLeft + 1)
  expect(bingeGalleryLayout.alternativesRight).toBeLessThanOrEqual(bingeGalleryLayout.galleryRight + 1)
  const bingeFeature = page.locator('.discover-binge__feature')
  const previousBingeTitle = await bingeFeature.getAttribute('data-active-title')
  await bingeFeature.getByRole('button', { name: 'Another option' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(bingeFeature).not.toHaveAttribute('data-active-title', previousBingeTitle || '')
  await expect(bingeFeature.locator('.discover-binge__copy')).toHaveCSS('animation-name', 'discover-binge-content-enter')
  await expect(bingeFeature.locator('.discover-binge__art img')).toHaveCSS('animation-name', 'discover-binge-art-enter')
  await page.getByRole('button', { name: 'Movies', exact: true }).click()
  const bigScreenShelf = page.locator('.discover-shelf--big-screen')
  await expect(bigScreenShelf).toHaveCount(1)
  await expect(bigScreenShelf.getByRole('heading', { name: 'Best in Widescreen' })).toBeVisible()
  const bigScreenLayout = await bigScreenShelf.evaluate((shelf) => {
    const rect = shelf.getBoundingClientRect()
    const firstCard = shelf.querySelector<HTMLElement>('.media-row-card-slot')?.getBoundingClientRect()
    return { viewport: document.documentElement.clientWidth, left: rect.left, right: rect.right, firstCard: firstCard?.toJSON() ?? null }
  })
  expect(bigScreenLayout.left).toBeGreaterThanOrEqual(0)
  expect(bigScreenLayout.right).toBeLessThanOrEqual(bigScreenLayout.viewport + 1)
  expect(bigScreenLayout.firstCard).not.toBeNull()
  expect(bigScreenLayout.firstCard!.left).toBeGreaterThanOrEqual(bigScreenLayout.left - 1)
  expect(bigScreenLayout.firstCard!.right).toBeLessThanOrEqual(bigScreenLayout.viewport + 1)
  await expect(page.locator('.discover-page .show-all-card')).toHaveCount(0)
  await page.locator('.discover-spotlight').first().scrollIntoViewIfNeeded()
  const discoveryLayout = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth
    const heading = document.querySelector<HTMLElement>('.discover-page__heading')
    const tabs = document.querySelector<HTMLElement>('.discover-page__tabs')
    const modes = document.querySelector<HTMLElement>('.discover-page__modes')
    const surprise = modes?.querySelector<HTMLElement>('.discover-surprise-trigger')
    const hero = document.querySelector<HTMLElement>('.discover-spotlight')
    const poster = document.querySelector<HTMLElement>('.discover-spotlight__poster')
    const copy = document.querySelector<HTMLElement>('.discover-spotlight__copy')
    const heroActions = hero ? Array.from(hero.querySelectorAll<HTMLElement>('.discover-spotlight__actions > button')) : []
    const bottomNav = document.querySelector<HTMLElement>('.mobile-web-nav')
    if (!heading || !tabs || !modes || !surprise || !bottomNav) return null
    const contained = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= -1 && bounds.right <= viewport + 1
    }
    return {
      viewport,
      document: document.documentElement.scrollWidth,
      headingFits: contained(heading),
      tabsFit: contained(tabs),
      modesFit: contained(modes),
      surpriseHeight: surprise.getBoundingClientRect().height,
      hero: hero ? {
        width: hero.getBoundingClientRect().width,
        height: hero.getBoundingClientRect().height,
        left: hero.getBoundingClientRect().left,
        right: hero.getBoundingClientRect().right,
        bottom: hero.getBoundingClientRect().bottom,
        bottomNavTop: bottomNav.getBoundingClientRect().top,
        ambientArtwork: Boolean(hero.querySelector('.discover-spotlight__ambient img')),
        backgroundColor: getComputedStyle(hero).backgroundColor,
        tonightFontSize: Number.parseFloat(getComputedStyle(hero.querySelector<HTMLElement>('.discover-spotlight__eyebrow')!).fontSize),
        overview: (() => {
          const element = hero.querySelector<HTMLElement>('.discover-spotlight__overview')
          if (!element) return null
          const bounds = element.getBoundingClientRect()
          return { visible: getComputedStyle(element).display !== 'none' && bounds.height > 0, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
        })(),
        actionsTop: hero.querySelector<HTMLElement>('.discover-spotlight__actions')?.getBoundingClientRect().top ?? 0,
      } : null,
      posterVisible: Boolean(poster && poster.getBoundingClientRect().width > 0),
      posterRightAligned: Boolean(poster && hero && poster.getBoundingClientRect().left > hero.getBoundingClientRect().left + hero.getBoundingClientRect().width * .55 && poster.getBoundingClientRect().right <= hero.getBoundingClientRect().right + 1),
      actionsFit: Boolean(hero && copy && heroActions.length >= 2 && heroActions.filter((button) => getComputedStyle(button).display !== 'none').every((button) => {
        const bounds = button.getBoundingClientRect()
        return bounds.left >= copy.getBoundingClientRect().left - 1 && bounds.right <= hero.getBoundingClientRect().right + 1 && bounds.bottom <= hero.getBoundingClientRect().bottom + 1
      })),
      actionsOnOneLine: (() => {
        const visible = heroActions.filter((button) => getComputedStyle(button).display !== 'none')
        return visible.length >= 2 && visible.every((button) => Math.abs(button.getBoundingClientRect().top - visible[0]!.getBoundingClientRect().top) <= 2)
      })(),
    }
  })
  expect(discoveryLayout).not.toBeNull()
  expect(discoveryLayout!.document).toBeLessThanOrEqual(discoveryLayout!.viewport + 1)
  expect(discoveryLayout!.headingFits).toBe(true)
  expect(discoveryLayout!.tabsFit).toBe(true)
  expect(discoveryLayout!.modesFit).toBe(true)
  expect(discoveryLayout!.surpriseHeight).toBeGreaterThanOrEqual(44)
  await expect(page.getByRole('combobox', { name: 'Browse recommendations' })).toHaveCount(0)
  if (discoveryLayout!.hero) {
    expect(discoveryLayout!.hero.left).toBeGreaterThanOrEqual(0)
    expect(discoveryLayout!.hero.right).toBeLessThanOrEqual(discoveryLayout!.viewport)
    expect(discoveryLayout!.hero.height).toBeGreaterThanOrEqual(280)
    expect(discoveryLayout!.hero.height).toBeLessThanOrEqual(420)
    expect(discoveryLayout!.hero.bottom).toBeLessThanOrEqual(discoveryLayout!.hero.bottomNavTop)
    expect(discoveryLayout!.hero.ambientArtwork).toBe(true)
    expect(discoveryLayout!.hero.backgroundColor).toBe('rgb(39, 39, 43)')
    expect(discoveryLayout!.hero.tonightFontSize).toBeGreaterThan(18)
    expect(discoveryLayout!.hero.overview?.visible, 'the phone spotlight should include the compact synopsis shown in the reference').toBe(true)
    expect(discoveryLayout!.hero.overview?.left).toBeGreaterThanOrEqual(0)
    expect(discoveryLayout!.hero.overview?.right).toBeLessThanOrEqual(discoveryLayout!.viewport)
    expect(discoveryLayout!.hero.actionsTop).toBeGreaterThanOrEqual(discoveryLayout!.hero.overview!.bottom - 1)
    expect(discoveryLayout!.posterVisible).toBe(true)
    expect(discoveryLayout!.posterRightAligned).toBe(true)
    expect(discoveryLayout!.actionsFit).toBe(true)
    expect(discoveryLayout!.actionsOnOneLine).toBe(true)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByRole('heading', { name: 'Your Next Obsession' })).toBeVisible()
  await expect(page.locator('.discover-next-hero').getByRole('button', { name: 'Not for me' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Surprise Me' })).toBeVisible()
  const desktopCardMotion = await page.locator('.discover-shelf--trending .media-row-card-slot > button').first().evaluate((card) => ({
    transitionDuration: getComputedStyle(card).transitionDuration,
    transitionProperty: getComputedStyle(card).transitionProperty,
  }))
  expect(parseFloat(desktopCardMotion.transitionDuration)).toBeGreaterThan(0)
  expect(desktopCardMotion.transitionProperty).toContain('transform')
  await expect(page.locator('.discover-spotlight__ambient img')).toHaveAttribute('src', /weekly-trend-backdrop/)
  await expect(page.locator('.discover-spotlight__ambient img')).toHaveCSS('opacity', '1')
  const desktopControlWidths = await page.evaluate(() => ({
    tabs: document.querySelector<HTMLElement>('.discover-page__tabs')?.getBoundingClientRect().width ?? 0,
  }))
  expect(desktopControlWidths.tabs, 'desktop media tabs should hug their options instead of leaving a blank control rail').toBeLessThanOrEqual(420)
  const desktopTasteCardWidth = await page.locator('.discover-taste-pick').first().evaluate((card) => card.getBoundingClientRect().width)
  expect(desktopTasteCardWidth).toBeLessThanOrEqual(125)
  const desktopDiscovery = await page.evaluate(() => {
    const spotlight = document.querySelector<HTMLElement>('.discover-spotlight')
    const page = document.querySelector<HTMLElement>('.discover-page')
    if (!spotlight || !page) return null
    const bounds = spotlight.getBoundingClientRect()
    return { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, left: bounds.left, right: bounds.right, height: bounds.height, poster: Boolean(spotlight.querySelector('.discover-spotlight__poster img')) }
  })
  const desktopPageLayout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, heading: Boolean(document.querySelector('.discover-page__heading h1')) }))
  expect(desktopPageLayout.scrollWidth).toBeLessThanOrEqual(desktopPageLayout.width + 1)
  expect(desktopPageLayout.heading).toBe(true)
  if (desktopDiscovery) {
    expect(desktopDiscovery.scrollWidth).toBeLessThanOrEqual(desktopDiscovery.width + 1)
    expect(desktopDiscovery.left).toBeGreaterThanOrEqual(0)
    expect(desktopDiscovery.right).toBeLessThanOrEqual(desktopDiscovery.width)
    expect(desktopDiscovery.height).toBeLessThanOrEqual(500)
    expect(desktopDiscovery.poster).toBe(true)
  }
  for (const width of [768, 1024, 1280, 1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    const desktopBounds = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth
      const page = document.querySelector<HTMLElement>('.discover-page')!
      const hero = document.querySelector<HTMLElement>('.discover-next-hero')!
      const copy = hero.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
      const poster = hero.querySelector<HTMLElement>('.discover-spotlight__poster')!.getBoundingClientRect()
      const binge = page.querySelector<HTMLElement>('.discover-binge__feature')
      const contentSections = Array.from(page.querySelectorAll<HTMLElement>(
        '.discover-next-hero, .discover-shelf, .discover-refine, .discover-genres, .discover-binge, .discover-time, .discover-more',
      )).map((section) => section.getBoundingClientRect())
      const time = page.querySelector<HTMLElement>('.discover-time')?.getBoundingClientRect()
      return {
        viewport,
        documentWidth: document.documentElement.scrollWidth,
        page: page.getBoundingClientRect().toJSON(),
        headingFontSize: Number.parseFloat(getComputedStyle(page.querySelector<HTMLElement>('.discover-page__heading h1')!).fontSize),
        heroHeight: hero.getBoundingClientRect().height,
        timeWidth: time?.width ?? 0,
        timeLeft: time?.left ?? 0,
        timeRight: time?.right ?? 0,
        sectionsInside: contentSections.every((bounds) => bounds.left >= -1 && bounds.right <= viewport + 1),
        heroColumnsSeparated: copy.right <= poster.left + 1,
        maxPosterCardRatio: Math.max(...Array.from(page.querySelectorAll<HTMLElement>('.discover-page .discover-shelf .media-row-card-slot'), (card) => card.getBoundingClientRect().height / Math.max(1, card.getBoundingClientRect().width))),
        bingeColumns: binge ? getComputedStyle(binge).gridTemplateColumns.split(' ').length : 0,
      }
    })
    expect(desktopBounds.documentWidth, `document overflow at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.page.left, `Discovery shifted offscreen at ${width}px`).toBeGreaterThanOrEqual(-1)
    expect(desktopBounds.page.right, `Discovery exceeds viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.sectionsInside, `a Discovery section exceeds the viewport at ${width}px`).toBe(true)
    expect(desktopBounds.timeWidth, `time picker should remain a readable width at ${width}px`).toBeGreaterThan(0)
    expect(desktopBounds.timeLeft, `time picker shifted offscreen at ${width}px`).toBeGreaterThanOrEqual(-1)
    expect(desktopBounds.timeRight, `time picker exceeds viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.heroColumnsSeparated, `hero copy overlaps its poster at ${width}px`).toBe(true)
    expect(desktopBounds.headingFontSize, `Discovery heading should stay within its desktop type scale at ${width}px`).toBeGreaterThanOrEqual(28)
    expect(desktopBounds.headingFontSize, `Discovery heading should stay within its desktop type scale at ${width}px`).toBeLessThanOrEqual(44)
    expect(desktopBounds.heroHeight, `Discovery spotlight should retain its desktop composition at ${width}px`).toBeGreaterThanOrEqual(300)
    expect(desktopBounds.heroHeight, `Discovery spotlight should not dominate the desktop page at ${width}px`).toBeLessThanOrEqual(500)
    expect(desktopBounds.maxPosterCardRatio, `Discovery poster cards should follow their artwork height at ${width}px`).toBeLessThanOrEqual(2.4)
    if (width >= 900 && desktopBounds.bingeColumns > 0) expect(desktopBounds.bingeColumns, `binge feature should use a horizontal desktop composition at ${width}px`).toBe(2)
  }
  await page.evaluate(() => { document.documentElement.dataset.runtimePlatform = 'tauri' })
  for (const width of [768, 1024, 1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    const desktopBounds = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth
      const page = document.querySelector<HTMLElement>('.discover-page')!
      const hero = document.querySelector<HTMLElement>('.discover-next-hero')!
      const time = page.querySelector<HTMLElement>('.discover-time')!.getBoundingClientRect()
      const copy = hero.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
      const poster = hero.querySelector<HTMLElement>('.discover-spotlight__poster')!.getBoundingClientRect()
      const shelfCard = page.querySelector<HTMLElement>('.discover-shelf .media-row-card-slot > button')
      return {
        viewport,
        documentWidth: document.documentElement.scrollWidth,
        page: page.getBoundingClientRect().toJSON(),
        headingFontSize: Number.parseFloat(getComputedStyle(page.querySelector<HTMLElement>('.discover-page__heading h1')!).fontSize),
        heroHeight: hero.getBoundingClientRect().height,
        heroAnimation: getComputedStyle(hero).animationName,
        shelfCardTransition: shelfCard ? getComputedStyle(shelfCard).transitionProperty : '',
        timeWidth: time.width,
        timeLeft: time.left,
        timeRight: time.right,
        heroColumnsSeparated: copy.right <= poster.left + 1,
        maxPosterCardRatio: Math.max(...Array.from(page.querySelectorAll<HTMLElement>('.discover-shelf .media-row-card-slot'), (card) => card.getBoundingClientRect().height / Math.max(1, card.getBoundingClientRect().width))),
      }
    })
    expect(desktopBounds.documentWidth, `Tauri document overflow at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.page.left, `Tauri Discovery shifted offscreen at ${width}px`).toBeGreaterThanOrEqual(-1)
    expect(desktopBounds.page.right, `Tauri Discovery exceeds viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.timeWidth, `Tauri time picker should remain visible at ${width}px`).toBeGreaterThan(0)
    expect(desktopBounds.timeLeft, `Tauri time picker shifted offscreen at ${width}px`).toBeGreaterThanOrEqual(-1)
    expect(desktopBounds.timeRight, `Tauri time picker exceeds viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.heroColumnsSeparated, `Tauri hero copy overlaps its poster at ${width}px`).toBe(true)
    expect(desktopBounds.heroAnimation, `Tauri editorial spotlight should animate at ${width}px`).not.toBe('none')
    expect(desktopBounds.shelfCardTransition, `Tauri shelf cards should keep their focus transitions at ${width}px`).toContain('transform')
    expect(desktopBounds.headingFontSize, `Tauri Discovery heading should stay within its desktop type scale at ${width}px`).toBeGreaterThanOrEqual(28)
    expect(desktopBounds.headingFontSize, `Tauri Discovery heading should stay within its desktop type scale at ${width}px`).toBeLessThanOrEqual(44)
    expect(desktopBounds.heroHeight, `Tauri spotlight should retain its desktop composition at ${width}px`).toBeGreaterThanOrEqual(300)
    expect(desktopBounds.heroHeight, `Tauri spotlight should not dominate the desktop page at ${width}px`).toBeLessThanOrEqual(500)
    expect(desktopBounds.maxPosterCardRatio, `Tauri Discovery poster cards should follow their artwork height at ${width}px`).toBeLessThanOrEqual(2.4)
  }
  await page.evaluate(() => { document.documentElement.dataset.runtimePlatform = 'web' })
  await page.setViewportSize({ width: 1024, height: 900 })
  const desktopTopTenShelf = page.locator('.discover-shelf').filter({ has: page.getByRole('heading', { name: 'Top 10 For You', exact: true }) })
  await desktopTopTenShelf.scrollIntoViewIfNeeded()
  const desktopTopTenRail = desktopTopTenShelf.locator('.media-row > div.overflow-x-auto')
  const desktopTopTenRight = desktopTopTenShelf.getByRole('button', { name: 'Scroll right' })
  await desktopTopTenRail.evaluate((rail) => { rail.scrollTo({ left: 0, behavior: 'instant' }); rail.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await expect.poll(() => desktopTopTenRail.evaluate((rail) => rail.scrollLeft)).toBeLessThanOrEqual(1)
  const desktopBeforeRight = await desktopTopTenRail.evaluate((rail) => ({ left: rail.scrollLeft, max: rail.scrollWidth - rail.clientWidth, width: rail.clientWidth }))
  expect(desktopBeforeRight.max, 'the ten-card shelf should have a measurable horizontal range at desktop tablet width').toBeGreaterThan(1)
  await expect(desktopTopTenRight, 'the ten-card Discovery shelf should overflow at desktop tablet width').toBeEnabled()
  await desktopTopTenRight.click()
  await expect.poll(() => desktopTopTenRail.evaluate((rail) => rail.scrollLeft)).toBeGreaterThan(desktopBeforeRight.left)
  const desktopAfterRight = await desktopTopTenRail.evaluate((rail) => ({ left: rail.scrollLeft, width: rail.clientWidth }))
  expect(desktopAfterRight.left - desktopBeforeRight.left).toBeLessThan(desktopAfterRight.width * .75)
  await desktopTopTenShelf.getByRole('button', { name: 'Scroll left' }).click()
  await expect.poll(() => desktopTopTenRail.evaluate((rail) => rail.scrollLeft)).toBeLessThanOrEqual(desktopBeforeRight.left + 1)
  await page.setViewportSize({ width: 1440, height: 900 })
  const spotlightBeforeAlternate = await page.locator('.discover-next-hero').getAttribute('data-title')
  const spotlightNode = await page.locator('.discover-next-hero').elementHandle()
  await page.locator('.discover-next-hero').getByRole('button', { name: 'Another option' }).click()
  await expect.poll(() => page.locator('.discover-next-hero').getAttribute('data-title')).not.toBe(spotlightBeforeAlternate)
  expect(await spotlightNode?.evaluate((element) => element.isConnected), 'changing the editorial pick should animate inside one stable spotlight instead of replacing the whole card').toBe(true)
  await spotlightNode?.dispose()
  const spotlightAfterAlternate = await page.locator('.discover-next-hero').getAttribute('data-title')
  await surpriseButton.click()
  await expect(pickerDialog).toBeVisible()
  await expect(pickerDialog).toHaveAttribute('aria-busy', 'true')
  await expect(pickerDialog.getByRole('status')).toHaveText('Finding something for you')
  await expect(pickerDialog.locator('.discover-picker__poster')).toHaveCSS('animation-name', 'discover-picker-rolling')
  await expect(pickerDialog).toHaveAttribute('aria-busy', 'false')
  const pickerTitle = await pickerDialog.locator('#discover-picker-title').innerText()
  expect(pickerTitle, 'Your Next Obsession is a separate editorial pick, never the randomizer result').not.toBe(spotlightAfterAlternate)
  await expect(page.locator('.discover-next-hero')).toHaveAttribute('data-title', spotlightAfterAlternate!)
  const desktopPickerLayout = await pickerDialog.evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect()
    const poster = dialog.querySelector<HTMLElement>('.discover-picker__poster')!.getBoundingClientRect()
    const copy = dialog.querySelector<HTMLElement>('.discover-picker__copy')!.getBoundingClientRect()
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, viewport: document.documentElement.clientWidth, posterRight: poster.right, copyLeft: copy.left, columns: getComputedStyle(dialog.querySelector<HTMLElement>('.discover-picker__body')!).gridTemplateColumns }
  })
  expect(desktopPickerLayout.left).toBeGreaterThanOrEqual(0)
  expect(desktopPickerLayout.right).toBeLessThanOrEqual(desktopPickerLayout.viewport)
  expect(desktopPickerLayout.top).toBeGreaterThan(0)
  expect(desktopPickerLayout.bottom).toBeLessThan(900)
  expect(desktopPickerLayout.copyLeft).toBeGreaterThanOrEqual(desktopPickerLayout.posterRight)
  expect(desktopPickerLayout.columns.split(' ').length).toBe(2)
  await pickerDialog.getByRole('button', { name: 'Close picker' }).click()
  await expect(pickerDialog).toHaveCount(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reducedMotionStyle = await page.locator('.discover-spotlight').first().evaluate((hero) => ({
    animation: getComputedStyle(hero).animationName,
    artworkAnimation: getComputedStyle(hero.querySelector('.discover-spotlight__ambient img')!).animationName,
    transitionDuration: getComputedStyle(hero.querySelector('.discover-spotlight__poster img')!).transitionDuration,
  }))
  expect(reducedMotionStyle.animation).toBe('none')
  expect(reducedMotionStyle.artworkAnimation).toBe('none')
  expect(parseFloat(reducedMotionStyle.transitionDuration)).toBeLessThanOrEqual(.00001)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  const moreToDiscover = page.getByRole('heading', { name: 'Keep Exploring', exact: true })
  await moreToDiscover.scrollIntoViewIfNeeded()
  await expect(moreToDiscover).toBeVisible()
  const moreSentinel = page.locator('.discover-more__sentinel')
  await moreSentinel.scrollIntoViewIfNeeded()
  const appScrollRoot = page.locator('.app-scroll-root')
  for (let attempt = 0; attempt < 5 && !continuationPages.has(4); attempt += 1) {
    await appScrollRoot.evaluate((root) => root.scrollTo({ top: root.scrollHeight, behavior: 'instant' }))
    await page.mouse.wheel(0, 700)
    await page.waitForTimeout(120)
  }
  await expect.poll(() => continuationPages.has(4), { timeout: 10_000 }).toBe(true)
  const continuedGrid = page.locator('.discover-more__grid')
  const firstContinuedCard = continuedGrid.getByRole('button', { name: 'More discovery fixture 1 More discovery fixture 1 2026', exact: true })
  await expect(firstContinuedCard).toBeVisible()
  await expect.poll(() => firstContinuedCard.evaluate((card) => getComputedStyle(card).animationName)).toBe('discover-more-card-arrive')
  await expect(continuedGrid.getByRole('button').first()).toHaveAccessibleName('More discovery fixture 1 More discovery fixture 1 2026')
  expect(continuationPages).toContain(4)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.mouse.move(0, 0)
  const topTenShelf = page.locator('.discover-shelf').filter({ has: page.getByRole('heading', { name: 'Top 10 For You', exact: true }) })
  const topTenCard = topTenShelf.locator('.media-row--ranked .media-row-card-slot').first()
  await expect.poll(() => topTenCard.locator('[data-hero-viewport]').evaluate((poster) => poster.getBoundingClientRect().width)).toBeLessThan(100)
  const topTenCardMeasure = await topTenCard.evaluate((card) => {
    const button = card.querySelector<HTMLElement>('button')!
    const poster = button.querySelector<HTMLElement>('[data-hero-viewport]')!
    return { posterWidth: poster.getBoundingClientRect().width, rankedHeight: getComputedStyle(button).getPropertyValue('--ranked-card-height').trim() }
  })
  expect(topTenCardMeasure.posterWidth, JSON.stringify(topTenCardMeasure)).toBeGreaterThanOrEqual(80)
  expect(topTenCardMeasure.posterWidth, JSON.stringify(topTenCardMeasure)).toBeLessThanOrEqual(100)
  await topTenShelf.getByRole('button', { name: 'Open Top 10 For You catalog' }).click()
  await expect(page.locator('.catalog-page h1')).toHaveText('Top 10 For You')
  await expect(page.locator('.catalog-page').getByText('10 titles loaded', { exact: true })).toBeVisible()
  await expect(page.locator('.catalog-page__items > button')).toHaveCount(10)
  const catalogGridColumns = await page.locator('.catalog-page__items').evaluate((grid) => new Set(Array.from(grid.children).map((card) => Math.round(card.getBoundingClientRect().left))).size)
  expect(catalogGridColumns).toBe(3)
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  const orTryShelf = page.locator('.discover-shelf--trending')
  const visibleOrTryOrder = await orTryShelf.locator('.media-row-card-slot img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')))
  await orTryShelf.getByRole('button', { name: 'Open OR TRY catalog' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('.catalog-page h1')).toHaveText('OR TRY')
  await expect.poll(() => page.locator('.catalog-page__items > button').count()).toBeGreaterThanOrEqual(visibleOrTryOrder.length)
  const fullOrTryOrder = await page.locator('.catalog-page__items img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')))
  expect(fullOrTryOrder.slice(0, 5), 'the full OR TRY catalog should use the same fresh, popularity-sorted entries as its shelf').toEqual(visibleOrTryOrder.slice(0, 5))
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  await expect(page.locator('.discover-shelf--recent')).toHaveCount(0)
  // TMDB interactive requests retry once; fail both attempts to exercise a
  // true partial response, then let the user's explicit retry succeed.
  animeMovieContinuationFailuresRemaining = 2
  await contentTypeControls.getByRole('button', { name: 'Anime' }).click()
  await expect(contentTypeControls.getByRole('button', { name: 'Anime' })).toHaveAttribute('aria-pressed', 'true')
  const animeMoreHeader = page.getByRole('heading', { name: 'Keep Exploring', exact: true })
  await animeMoreHeader.scrollIntoViewIfNeeded()
  const animeAppScrollRoot = page.locator('.app-scroll-root')
  for (let attempt = 0; attempt < 8 && !animeContinuationResponses.includes('movie:4:failed'); attempt += 1) {
    await animeAppScrollRoot.evaluate((root) => root.scrollTo({ top: root.scrollHeight, behavior: 'instant' }))
    await page.waitForTimeout(150)
  }
  await expect.poll(() => animeContinuationResponses).toContain('movie:4:failed')
  const animeContinuationGrid = page.locator('.discover-more__grid')
  await expect(animeContinuationGrid.getByText('Anime series continuation page 4 title 1', { exact: true })).toBeVisible()
  const retryAnimeContinuation = page.getByRole('button', { name: 'Retry loading titles' })
  await expect(retryAnimeContinuation).toBeVisible()
  await retryAnimeContinuation.click()
  await expect.poll(() => animeContinuationResponses).toContain('movie:4:ok')
  await expect(animeContinuationGrid.getByText('Anime movie continuation page 4 title 1', { exact: true })).toBeVisible()

  const episodeCardWidth = await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.className = 'detail-page'
    fixture.innerHTML = '<div class="detail-episodes-section"><div class="detail-episode-track"><button class="episode-showcase-card">Episode</button></div></div>'
    document.querySelector('.app-theme-shell')!.append(fixture)
    const card = fixture.querySelector<HTMLElement>('.episode-showcase-card')!
    const width = card.getBoundingClientRect().width
    fixture.remove()
    return width
  })
  expect(episodeCardWidth, 'phone episode cards should stay compact and horizontally browsable').toBeLessThanOrEqual(280)
  expect(pageErrors).toEqual([])
})

test('mobile series detail uses compact system typography and contained episode cards', async ({ page }) => {
  const renderLoopWarnings: string[] = []
  page.on('console', (message) => {
    if (/Maximum update depth exceeded/i.test(message.text())) renderLoopWarnings.push(message.text())
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aurales_app_managed_metadata', 'false'))
  await page.goto('/series/pwa-mobile-detail-layout')
  await page.getByRole('button', { name: /select profile/i }).click()
  const detail = page.locator('.detail-page--series')
  await expect(detail).toBeVisible()
  await expect(detail.locator('.detail-episodes-heading h2')).toBeVisible()

  const layout = await page.evaluate(() => {
    const detail = document.querySelector<HTMLElement>('.detail-page--series')!
    const hero = detail.querySelector<HTMLElement>('.detail-hero-panel')!
    const brand = detail.querySelector<HTMLElement>('.detail-hero-panel__brand')!
    const classification = detail.querySelector<HTMLElement>('.detail-hero-classification')!
    const overview = detail.querySelector<HTMLElement>('.detail-hero-overview')
    const actions = detail.querySelector<HTMLElement>('.detail-hero-actions')
    const heading = detail.querySelector<HTMLElement>('.detail-episodes-heading h2')!
    const episode = detail.querySelector<HTMLElement>('.episode-showcase-card')
    const font = getComputedStyle(detail).fontFamily
    const bounds = (element: HTMLElement | null) => element?.getBoundingClientRect().toJSON() ?? null
    return {
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      font,
      hero: bounds(hero),
      brand: bounds(brand),
      classification: bounds(classification),
      overview: bounds(overview),
      actions: bounds(actions),
      headingFontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
      episode: bounds(episode),
    }
  })

  expect(layout.document).toBeLessThanOrEqual(layout.viewport + 1)
  expect(layout.font).toContain('system-ui')
  expect(layout.hero?.height).toBeLessThanOrEqual(570)
  expect(layout.headingFontSize).toBeLessThanOrEqual(20)
  expect(layout.episode?.width).toBeGreaterThan(120)
  expect(layout.episode?.width).toBeLessThanOrEqual(layout.viewport * .46 + 1)
  const content = [layout.brand, layout.classification, layout.overview, layout.actions].filter((box) => box !== null)
  for (let index = 1; index < content.length; index += 1) {
    expect(content[index]!.top, 'detail hero copy and actions must not overlap').toBeGreaterThanOrEqual(content[index - 1]!.bottom - 1)
  }
  expect(renderLoopWarnings).toEqual([])
})
