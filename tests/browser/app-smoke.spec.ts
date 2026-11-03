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

test('Discovery stays visible and stops motion when the system requests reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.getByRole('link', { name: 'Discover' }).click()

  const discovery = page.locator('.discover-page')
  await expect(discovery).toBeVisible()
  const firstReveal = discovery.locator('.discover-reveal').first()
  await expect.poll(() => firstReveal.getAttribute('data-revealed')).toBe('true')
  const motion = await firstReveal.evaluate((element) => ({
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    opacity: getComputedStyle(element).opacity,
    transformIsIdentity: new DOMMatrixReadOnly(getComputedStyle(element).transform).isIdentity,
    transitionDurationSeconds: Number.parseFloat(getComputedStyle(element).transitionDuration),
  }))
  expect(motion.reduced).toBe(true)
  expect(motion.opacity).toBe('1')
  expect(motion.transformIsIdentity).toBe(true)
  expect(motion.transitionDurationSeconds).toBeLessThanOrEqual(0.0001)
})

test('Discovery uses public catalogs when the active profile has no library entries', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(() => {
    const profileId = 'playwright-empty-library-discovery'
    localStorage.setItem('aurales_profiles_v1', JSON.stringify([{
      id: profileId,
      name: 'Default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      isDefault: true,
    }]))
    localStorage.setItem('aurales_active_profile_v1', profileId)
    localStorage.setItem(`aurales_skip_profile_picker:profile:${profileId}`, 'true')
    localStorage.setItem('aurales_app_managed_metadata', 'false')
    localStorage.setItem('tmdb_api_key', 'playwright-public-test-key')
  })
  await page.route('https://api.ids.moe/**', (route) => route.fulfill({ json: {} }))
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const url = new URL(route.request().url())
    const isTrending = /^\/3\/trending\/(movie|tv)\/week$/.test(url.pathname)
    const type = url.pathname.includes('/tv/') || url.pathname.endsWith('/discover/tv') ? 'series' : 'movie'
    const results = Array.from({ length: isTrending ? 6 : 12 }, (_, index) => ({
      id: (isTrending ? 98000 : 98100) + index,
      title: isTrending ? `Weekly public trend ${index + 1}` : `Public catalog fixture ${index + 1}`,
      name: isTrending ? `Weekly public trend ${index + 1}` : `Public catalog fixture ${index + 1}`,
      poster_path: `/public-discovery-${isTrending ? 'trend' : 'catalog'}-${index + 1}.jpg`,
      backdrop_path: `/public-discovery-backdrop-${index + 1}.jpg`,
      overview: 'A public catalog title used to verify an empty-library Discovery session.',
      release_date: '2026-10-01',
      first_air_date: '2026-10-01',
      vote_average: 8.1,
      vote_count: 1200,
      popularity: 180 - index * 8,
      genre_ids: type === 'movie' ? [18, 35, 878, 14] : [18, 10759, 10765],
      original_language: 'en',
    }))
    await route.fulfill({ json: { page: 1, total_pages: 1, total_results: results.length, results } })
  })
  await page.route('https://image.tmdb.org/**', (route) => route.fulfill({
    headers: { 'Access-Control-Allow-Origin': '*' },
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 6"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#d87543"/><stop offset="1" stop-color="#172638"/></linearGradient></defs><rect width="4" height="6" fill="url(#g)"/></svg>',
  }))

  await page.goto('/discover')
  await expect(page.locator('.discover-page')).toBeVisible()
  await expect(page.locator('.discover-next-hero')).toHaveAttribute('data-title', /^Weekly public trend /, { timeout: 15_000 })
  await expect(page.locator('.discover-shelf--trending')).toBeVisible()
  await expect(page.locator('.discover-shelf--trending img').first()).toHaveAttribute('alt', /^Weekly public trend /)
  await expect(page.locator('.discover-refine .discover-taste-pick').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Top 10 For You', exact: true })).toBeVisible()
  await expect(page.locator('.discover-refine .discover-taste-pick__title').filter({ hasText: 'Public catalog fixture' }).first()).toBeVisible()
  await expect(page.locator('.discover-more__sentinel')).toContainText('Keep scrolling for more titles')
  await expect(page.locator('.discover-shelf--new-library')).toHaveCount(0)
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
    localStorage.setItem(`aurales_skip_profile_picker:profile:${id}`, 'true')
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
  await expect(page.locator('main')).toBeVisible()
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
    const profileId = 'playwright-discovery-profile'
    localStorage.setItem('aurales_profiles_v1', JSON.stringify([{
      id: profileId,
      name: 'Default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      isDefault: true,
    }]))
    localStorage.setItem('aurales_active_profile_v1', profileId)
    localStorage.setItem(`aurales_skip_profile_picker:profile:${profileId}`, 'true')
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
  const runtimeFilters: string[] = []
  const continuationPages = new Set<number>()
  const animeContinuationResponses: string[] = []
  let animeMovieContinuationFailuresRemaining = 0
  await page.route('https://api.ids.moe/**', (route) => route.fulfill({ json: {} }))
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    tmdbRequestPaths.add(requestUrl.pathname)
    const runtimeFilter = [requestUrl.searchParams.get('with_runtime.gte'), requestUrl.searchParams.get('with_runtime.lte')].join('-')
    if (runtimeFilter !== '-') runtimeFilters.push(runtimeFilter)
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
        // Make the most popular continuation item less personally attractive
        // than the rest so the long-tail surface proves it keeps popularity first.
        vote_average: index === 0 ? 5 : 8.5,
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
      popularity: index >= 32 ? 30 - (index - 32) : 160 - index,
      genre_ids: [18, 35, 53, 27, 80, 9648, 878, 10765, 10759, 10751, 10762, 14],
      original_language: 'en',
    }))
    await route.fulfill({ json: { page: requestedPage, total_pages: isUnfilteredMoviePage ? 4 : 1, total_results: results.length, results } })
  })
  await page.route('https://image.tmdb.org/**', (route) => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 3"><rect width="2" height="3" fill="#777"/></svg>' }))

  await page.goto('/movie/mobile-layout-fixture')
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
  const colourSection = page.locator('.discover-colors')
  await expect(colourSection).toBeVisible({ timeout: 15_000 })
  const monochromeFilter = colourSection.getByRole('button', { name: 'Mono', exact: true })
  await expect(monochromeFilter).toBeVisible()
  await monochromeFilter.click()
  await expect(colourSection.locator('.media-row h2')).toHaveText('Mono Posters')
  await expect(monochromeFilter).toHaveAttribute('aria-pressed', 'true')
  const heroSpotlight = page.locator('.discover-next-hero')
  const obsessionCard = heroSpotlight
  await expect(page.locator('.discover-spotlight-heading').getByRole('heading', { name: 'Your Next Obsession' })).toBeVisible()
  const heroBackdrop = heroSpotlight.locator('.discover-spotlight__ambient img')
  const heroPoster = heroSpotlight.locator('.discover-spotlight__poster img')
  await expect(heroBackdrop).toHaveAttribute('src', /weekly-trend-backdrop/)
  await expect(heroBackdrop).toHaveClass(/is-loaded/)
  await expect(heroBackdrop).toHaveCSS('opacity', '1')
  await expect(heroPoster).toHaveAttribute('data-artwork-loaded', 'true')
  await expect(heroPoster).toHaveCSS('opacity', '1')
  await expect(page.locator('.discover-libraries')).toHaveCount(0)
  await expect(page.locator('.discover-shelf--favorites, .discover-shelf--new-library')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /^Because You / })).toHaveCount(0)
  const calendar = page.locator('.discover-calendar')
  await expect(calendar).toBeVisible()
  await expect(calendar.getByRole('status')).toHaveText('No upcoming releases in the next 30 days.')
  await expect(calendar.getByRole('button', { name: 'Open calendar' })).toBeVisible()
  const personalizedSeedShelf = page.locator('.discover-shelf--personal-seed')
  await expect(personalizedSeedShelf).toBeVisible({ timeout: 15_000 })
  await expect(personalizedSeedShelf.locator('.discover-media-row-heading > span')).toHaveText('Because you favorited')
  await expect(personalizedSeedShelf.locator('.discover-media-row-heading h2')).toHaveText('Recently Added Library Fixture')
  await expect(personalizedSeedShelf.locator('.discover-seed-tabs button[aria-pressed="true"]')).toHaveText('Recently Added Library Fixture')
  await expect(page.getByRole('heading', { name: 'Continue Watching', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your Next Obsession' })).toBeVisible()
  const obsessionLayout = await heroSpotlight.evaluate((card) => {
    const poster = card.querySelector<HTMLElement>('.discover-spotlight__poster')!.getBoundingClientRect()
    const title = card.querySelector<HTMLElement>('.discover-spotlight__bottom > .discover-spotlight__logo, .discover-spotlight__bottom > h2')!.getBoundingClientRect()
    const copy = card.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
    return { viewport: document.documentElement.clientWidth, card: card.getBoundingClientRect().toJSON(), poster: poster.toJSON(), title: title.toJSON(), copy: copy.toJSON() }
  })
  expect(obsessionLayout.card.left, 'the editorial pick should align with the mobile page gutter').toBeGreaterThanOrEqual(12)
  expect(obsessionLayout.poster.width, 'the editorial poster should remain visible in the mobile spotlight').toBeGreaterThanOrEqual(84)
  expect(obsessionLayout.poster.width).toBeLessThanOrEqual(124)
  expect(obsessionLayout.poster.left).toBeGreaterThan(obsessionLayout.copy.right)
  expect(obsessionLayout.title.left).toBeGreaterThanOrEqual(obsessionLayout.card.left + 8)
  expect(obsessionLayout.title.right).toBeLessThanOrEqual(obsessionLayout.card.right - 8)
  expect(obsessionLayout.card.height, 'the mobile editorial spotlight should fit its Tonight copy without a large blank lower half').toBeLessThanOrEqual(360)
  await expect(heroSpotlight.getByText('Tonight', { exact: true })).toBeVisible()
  await expect(heroSpotlight.locator('.discover-spotlight__accolade')).toBeVisible()
  await expect(heroSpotlight.locator('.discover-spotlight__accolade')).toHaveText(/^(In Cinema|New Movie|Top Rated)$/)
  await expect(heroSpotlight.getByRole('button', { name: /Another option/ })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'OR TRY', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Top 10 For You', exact: true })).toBeVisible()
  await expect(page.locator('.discover-tonight')).toHaveCount(0)
  const discoverySurfaceOrder = await page.evaluate(() => {
    const topTen = [...document.querySelectorAll<HTMLElement>('.discover-shelf h2')].find((heading) => heading.textContent?.trim() === 'Top 10 For You')
    const obsession = document.querySelector<HTMLElement>('.discover-next-hero')
    const refine = document.querySelector<HTMLElement>('.discover-refine')
    return Boolean(obsession && topTen && refine
      && obsession.compareDocumentPosition(topTen) & Node.DOCUMENT_POSITION_FOLLOWING
      && topTen.compareDocumentPosition(refine) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(discoverySurfaceOrder, 'the editorial spotlight leads into public catalogs and taste refinement').toBe(true)
  const mobileDiscoveryLayout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      const root = document.querySelector<HTMLElement>('.app-scroll-root')
      const y = bounds.top - (root?.getBoundingClientRect().top ?? 0) + (root?.scrollTop ?? window.scrollY)
      return { y, height: bounds.height }
    }
    const headingRect = (label: string) => {
      const element = [...document.querySelectorAll<HTMLElement>('.discover-shelf h2')]
        .find((heading) => heading.textContent?.trim() === label)
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      const root = document.querySelector<HTMLElement>('.app-scroll-root')
      const y = bounds.top - (root?.getBoundingClientRect().top ?? 0) + (root?.scrollTop ?? window.scrollY)
      return { y, height: bounds.height }
    }
    return {
      profileWelcomeHeading: rect('.discover-page__heading h1'),
      browseControls: rect('.discover-page__tabs'),
      obsessionHeading: rect('#discover-next-title'),
      obsessionCard: rect('.discover-next-hero'),
      trendingHeading: headingRect('OR TRY'),
      topTenHeading: headingRect('Top 10 For You'),
    }
  })
  const { profileWelcomeHeading, browseControls, obsessionHeading, obsessionCard: spotlightBounds, trendingHeading, topTenHeading } = mobileDiscoveryLayout
  expect(Object.values(mobileDiscoveryLayout).every(Boolean), 'all major Discovery sections should have layout boxes').toBe(true)
  const obsessionTop = obsessionHeading!.y
  const trendingTop = trendingHeading!.y
  const topTenTop = topTenHeading!.y
  expect(obsessionTop).toBeLessThan(trendingTop)
  expect(trendingTop).toBeLessThan(topTenTop)
  await expect(page.getByRole('heading', { name: 'New in Your Library', exact: true })).toBeVisible()
  await expect(page.locator('.discover-shelf--recent')).toBeVisible()
  await expect(heroSpotlight.getByRole('button', { name: 'Details' })).toBeVisible()
  const firstSpotlightTitle = await obsessionCard.getAttribute('data-title')
  expect(firstSpotlightTitle).not.toBeNull()
  const editorialTopTenShelf = page.locator('.discover-shelf').filter({ has: page.getByRole('heading', { name: 'Top 10 For You', exact: true }) })
  await expect(page.locator('.discover-shelf--trending').getByText(firstSpotlightTitle!, { exact: true })).toHaveCount(0)
  await expect(editorialTopTenShelf.getByText(firstSpotlightTitle!, { exact: true })).toHaveCount(0)
  await expect.poll(() => editorialTopTenShelf.locator('img').evaluateAll((images) => images.filter((image) => /^Weekly trend \d+$/.test(image.getAttribute('alt') || '')).length)).toBeGreaterThan(0)
  const promotedTrendTitles = await editorialTopTenShelf.locator('img').evaluateAll((images) => images.map((image) => image.getAttribute('alt') || '').filter((title) => /^Weekly trend \d+$/.test(title)))
  expect(promotedTrendTitles.length, 'Top 10 should reserve three places for fresh weekly trends while keeping the editorial Spotlight separate').toBe(3)
  const mobileSpotlight = page.locator('.discover-next-hero')
  const mobileSpotlightTitle = await mobileSpotlight.getAttribute('data-title')
  await mobileSpotlight.getByRole('button', { name: /Another option/ }).click()
  await expect.poll(() => mobileSpotlight.getAttribute('data-title')).not.toBe(mobileSpotlightTitle)
  const mobileSpotlightMotion = await mobileSpotlight.evaluate((hero) => {
    const movingSurfaces = [
      hero.querySelector<HTMLElement>('.discover-spotlight__copy'),
      hero.querySelector<HTMLElement>('.discover-spotlight__poster'),
    ]
    return movingSurfaces.map((surface) => Boolean(surface?.getAnimations().length))
  })
  expect(mobileSpotlightMotion, 'the independent editorial Tonight pick and its poster should animate together').toEqual([true, true])
  await expect(mobileSpotlight.locator('.discover-spotlight__ambient img')).toHaveCSS('animation-name', 'discover-art-enter')
  await expect.poll(() => mobileSpotlight.locator('.discover-spotlight__copy').evaluate((copy) => copy.getAnimations().every((animation) => animation.playState !== 'running'))).toBe(true)
  await page.getByRole('button', { name: 'Not for me' }).click()
  await expect(page.locator('.discover-picker')).toHaveCount(0)
  const discoverySettings = page.getByRole('button', { name: 'Discovery settings' })
  await discoverySettings.evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('dialog', { name: 'Discovery settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Discovery settings' })).toHaveCount(0)
  await expect(discoverySettings).toBeFocused()
  await expect(page.locator('.discover-spotlight-heading').getByRole('heading', { name: 'Your Next Obsession' })).toBeVisible()
  expect(profileWelcomeHeading!.y + profileWelcomeHeading!.height).toBeLessThan(browseControls!.y)
  expect(obsessionHeading!.y).toBeGreaterThan(browseControls!.y)
  expect(obsessionHeading!.y + obsessionHeading!.height).toBeLessThan(spotlightBounds!.y)
  await expect(page.getByRole('heading', { name: 'Trending Now', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Top 10 For You', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Drama Picks', exact: true })).toHaveCount(0)
  await expect(page.locator('.discover-shelf--personal-genre')).toHaveCount(0)
  await expect(page.locator('.discover-shelf--big-screen')).toBeVisible()
  await expect(page.locator('.discover-shelf--recent')).toBeVisible()
  await expect(page.locator('.discover-shelf--gems')).toBeVisible()
  await expect(page.locator('.discover-shelf--top-rated')).toHaveCount(0)
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
  const shelfStagger = await trendingShelf.locator('.media-row-card-slot').evaluateAll((cards) => cards.slice(0, 10).map((card) => getComputedStyle(card).animationDelay))
  expect(shelfStagger).toEqual(['0s', '0.032s', '0.064s', '0.096s', '0.128s', '0.16s', '0.192s', '0.224s'])
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
  const trendingRail = trendingShelf.locator('[data-media-row-track]')
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
  expect(trendingRailOrder, `the independent editorial pick should lead into OR TRY and Top 10 (headings: ${await page.locator('.discover-shelf h2').allTextContents()})`).toBe(true)
  const pickerBeforeShelves = await page.evaluate(() => {
    const picker = document.querySelector('#discover-refine-title')
    const topTen = Array.from(document.querySelectorAll('.discover-shelf h2')).find((heading) => heading.textContent?.trim() === 'Top 10 For You')
    return Boolean(picker && topTen && (topTen.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  expect(pickerBeforeShelves, 'the broad public recommendations should lead into the taste picker').toBe(true)
  await expect(page.getByRole('heading', { name: 'Your Genres' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'How Much Time Tonight?' })).toBeVisible()
  const timeTonightRail = page.locator('.discover-time .media-row')
  await expect(timeTonightRail).toBeVisible()
  await expect.poll(() => timeTonightRail.locator('.media-row-card-slot').count()).toBeGreaterThan(0)
  await timeTonightRail.getByRole('button', { name: 'Open How Much Time Tonight? catalog' }).click()
  const timeTonightCatalog = page.locator('.catalog-page')
  await expect(timeTonightCatalog.getByRole('heading', { name: 'How Much Time Tonight?', exact: true })).toBeVisible()
  const timeTonightCount = Number.parseInt((await timeTonightCatalog.getByText(/^\d+ titles loaded$/).textContent()) || '', 10)
  expect(timeTonightCount, 'the runtime catalog should show the complete selected set').toBeGreaterThan(0)
  expect(timeTonightCount, 'the runtime catalog should remain a focused shelf').toBeLessThanOrEqual(10)
  await expect(timeTonightCatalog.locator('button:has(img)')).toHaveCount(timeTonightCount)
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  const spotlightBeforeRuntimeChange = await page.locator('.discover-next-hero').getAttribute('data-title')
  await expect(page.locator('.discover-time')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Made for the Big Screen' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Hidden Gems', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'New in Your Library', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sunday Night Moods' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Choose a watch duration' }).getByRole('button')).toHaveCount(3)
  await expect(page.getByRole('group', { name: 'Choose a mood' }).getByRole('button')).toHaveCount(3)
  const runtimeControls = page.getByRole('group', { name: 'Choose a watch duration' })
  await runtimeControls.getByRole('button', { name: 'Under 90 Minutes' }).click()
  await expect(runtimeControls.getByRole('button', { name: 'Under 90 Minutes' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => runtimeFilters.includes('1-89')).toBe(true)
  await expect(page.locator('.discover-next-hero')).toHaveAttribute('data-title', spotlightBeforeRuntimeChange!)
  await expect(page.getByRole('heading', { name: 'Pick by Colour' })).toBeVisible()
  await contentTypeControls.getByRole('button', { name: 'Anime', exact: true }).click()
  await expect(page.locator('.discover-next-hero .discover-spotlight__meta')).toContainText('Anime')
  await contentTypeControls.getByRole('button', { name: 'Movies', exact: true }).click()
  const discoveryFlow = await page.locator('.discover-page').evaluate((root) => {
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h2, h3')).map((heading) => heading.textContent?.trim() || '')
    const referenceOrder = ['Your Next Obsession', 'OR TRY', 'Top 10 For You', 'How Much Time Tonight?', 'Pick Three You Like', 'Pick by Colour', 'Your Genres', 'Your Next Binge', 'Sunday Night Moods', 'Made for the Big Screen', 'Hidden Gems', 'New in Your Library', 'Keep Exploring']
    return referenceOrder.filter((title) => headings.includes(title)).map((title) => headings.indexOf(title))
  })
  expect(discoveryFlow.every((position, index) => index === 0 || position > discoveryFlow[index - 1]!), 'Discovery shelves should follow the order shown in the reference video').toBe(true)
  await expect(page.locator('.discover-taste-pick')).toHaveCount(10)
  const tastePickTitles = await page.locator('.discover-taste-pick__title').allTextContents()
  const tasteSpotlightTitle = await page.locator('.discover-next-hero').getAttribute('data-title')
  expect(tastePickTitles.some((title) => /^Weekly trend \d+$/.test(title)), 'Pick Three should use the live weekly trend feed ahead of an older daily snapshot').toBe(true)
  expect(tastePickTitles).not.toContain(tasteSpotlightTitle)
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
  expect(mobilePosterSpacing!.firstWidth).toBeGreaterThanOrEqual(100)
  expect(mobilePosterSpacing!.firstWidth).toBeLessThanOrEqual(120)
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
  expect(mobileTasteGrid.cardWidth).toBeGreaterThanOrEqual(100)
  expect(mobileTasteGrid.cardWidth).toBeLessThanOrEqual(120)
  expect(mobileTasteGrid.posterWidth).toBeGreaterThan(0)
  await page.locator('.discover-taste-picks').evaluate((grid) => { grid.scrollLeft = 100 })
  await expect.poll(() => page.locator('.discover-taste-picks').evaluate((grid) => grid.scrollLeft)).toBeGreaterThan(0)

  await page.locator('.discover-genres__grid button').filter({ hasText: 'Drama' }).first().click()
  await expect(page.locator('#discover-genre-picks').getByRole('button', { name: 'Open Drama Picks catalog' })).toBeVisible()
  await expect.poll(() => page.locator('#discover-genre-picks .media-row-card-slot').count()).toBeGreaterThan(0)
  await page.locator('.discover-genres__grid button').filter({ hasText: 'Action' }).first().click()
  await expect(page.locator('#discover-genre-picks [role="status"]')).toContainText('Finding Action titles')
  // WebKit takes longer to settle uncached discovery requests than Chromium.
  // Wait for the row request to finish before asserting its empty state.
  await expect(page.getByText(/no titles found for action yet/i)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#discover-genre-picks .media-row-card-slot')).toHaveCount(0)
  const emptyGenreMessage = page.getByText(/no titles found for action yet/i)
  expect(await emptyGenreMessage.evaluate((message) => message.getBoundingClientRect().height), 'an empty genre should show its message without reserving a full poster-row gap').toBeLessThan(44)

  const surpriseButton = page.getByRole('button', { name: /surprise me/i })
  await expect(surpriseButton).toBeEnabled()
  const startingTitle = await obsessionCard.getAttribute('data-title')
  const startingHeroTitle = await heroSpotlight.getAttribute('data-title')
  const startingTimeTonightTitles = await page.locator('.discover-time .media-row-card-slot img').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).alt))
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
  await expect(surpriseButton).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 })
  await expect(pickerDialog.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  await expect(pickerDialog.getByRole('button', { name: 'Spin again', exact: true })).toBeVisible()
  await expect(heroSpotlight).toHaveAttribute('data-title', startingHeroTitle!)
  expect(await page.locator('.discover-time .media-row-card-slot img').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).alt))).toEqual(startingTimeTonightTitles)
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
  await expect(pickerDialog).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 })
  await expect(pickerDialog.getByRole('button', { name: /Not for me/i })).toBeVisible()
  const dismissedTitle = await pickerDialog.locator('.discover-picker__copy').getAttribute('data-title')
  await pickerDialog.getByRole('button', { name: /Not for me/i }).click()
  expect(dismissedTitle).not.toBe(startingTitle)
  await expect(pickerDialog).toHaveCount(0)
  await surpriseButton.evaluate((button: HTMLButtonElement) => button.click())
  await expect(pickerDialog).toBeVisible()
  await expect(pickerDialog).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 })
  await expect(pickerDialog.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
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
  await expect(page.locator('.discover-binge__main-poster img')).toHaveAttribute('alt', 'Weekly trend 1 poster')
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
  await expect(page.locator('.discover-shelf--big-screen')).toBeVisible()
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
      controlsWidth: document.querySelector<HTMLElement>('.discover-page__controls')!.getBoundingClientRect().width,
      tabsWidth: tabs.getBoundingClientRect().width,
      modesWidth: modes.getBoundingClientRect().width,
      controlsSameRow: Math.abs((tabs.getBoundingClientRect().top + tabs.getBoundingClientRect().bottom) / 2 - (modes.getBoundingClientRect().top + modes.getBoundingClientRect().bottom) / 2) <= 2 && modes.getBoundingClientRect().left >= tabs.getBoundingClientRect().right - 1,
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
        overview: (() => {
          const element = hero.querySelector<HTMLElement>('.discover-spotlight__overview')
          if (!element) return null
          const bounds = element.getBoundingClientRect()
          return { visible: getComputedStyle(element).display !== 'none' && bounds.height > 0, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
        })(),
        actionsTop: hero.querySelector<HTMLElement>('.discover-spotlight__actions')?.getBoundingClientRect().top ?? 0,
      } : null,
      posterVisible: Boolean(poster && poster.getBoundingClientRect().width > 0),
      posterRightAligned: Boolean(poster && hero && poster.getBoundingClientRect().left > hero.getBoundingClientRect().left + hero.getBoundingClientRect().width * .5 && poster.getBoundingClientRect().right <= hero.getBoundingClientRect().right - 8),
      actionsFit: Boolean(hero && copy && heroActions.length >= 2 && heroActions.filter((button) => getComputedStyle(button).display !== 'none').every((button) => {
        const bounds = button.getBoundingClientRect()
        return bounds.left >= hero.getBoundingClientRect().left - 1 && bounds.right <= hero.getBoundingClientRect().right + 1 && bounds.bottom <= hero.getBoundingClientRect().bottom + 1
      })),
      actionsStayInRows: (() => {
        const visible = heroActions.filter((button) => getComputedStyle(button).display !== 'none')
        const change = hero?.querySelector<HTMLElement>('.discover-spotlight__change')
        return visible.length >= 3 && Boolean(change && visible.every((button) => Math.abs(button.getBoundingClientRect().top - visible[0]!.getBoundingClientRect().top) <= 2 || button === change && button.getBoundingClientRect().top > visible[0]!.getBoundingClientRect().top))
      })(),
    }
  })
  expect(discoveryLayout).not.toBeNull()
  expect(discoveryLayout!.document).toBeLessThanOrEqual(discoveryLayout!.viewport + 1)
  expect(discoveryLayout!.headingFits).toBe(true)
  expect(discoveryLayout!.tabsFit).toBe(true)
  expect(discoveryLayout!.tabsWidth + discoveryLayout!.modesWidth).toBeLessThanOrEqual(discoveryLayout!.controlsWidth + 1)
  expect(discoveryLayout!.tabsWidth).toBeGreaterThanOrEqual(160)
  expect(discoveryLayout!.controlsSameRow, `Discovery tabs and actions should share one aligned row: ${JSON.stringify(discoveryLayout)}`).toBe(true)
  expect(discoveryLayout!.modesFit).toBe(true)
  expect(discoveryLayout!.surpriseHeight).toBeGreaterThanOrEqual(44)
  await page.locator('.app-scroll-root').evaluate((root) => root.scrollTo({ top: 0, behavior: 'instant' }))
  await expect(page.getByRole('combobox', { name: 'Browse recommendations' })).toHaveCount(0)
  if (discoveryLayout!.hero) {
    expect(discoveryLayout!.hero.left).toBeGreaterThanOrEqual(0)
    expect(discoveryLayout!.hero.right).toBeLessThanOrEqual(discoveryLayout!.viewport)
    expect(discoveryLayout!.hero.height).toBeGreaterThanOrEqual(280)
    expect(discoveryLayout!.hero.height).toBeLessThanOrEqual(420)
    expect(discoveryLayout!.hero.bottom).toBeLessThanOrEqual(discoveryLayout!.hero.bottomNavTop)
    expect(discoveryLayout!.hero.ambientArtwork).toBe(true)
    expect(discoveryLayout!.hero.backgroundColor).toBe('rgb(39, 39, 43)')
    expect(discoveryLayout!.hero.overview?.visible, 'the phone spotlight should include the compact synopsis shown in the reference').toBe(true)
    expect(discoveryLayout!.hero.overview?.left).toBeGreaterThanOrEqual(0)
    expect(discoveryLayout!.hero.overview?.right).toBeLessThanOrEqual(discoveryLayout!.viewport)
    expect(discoveryLayout!.hero.actionsTop).toBeGreaterThanOrEqual(discoveryLayout!.hero.overview!.bottom - 1)
    expect(discoveryLayout!.posterVisible).toBe(true)
    expect(discoveryLayout!.posterRightAligned).toBe(true)
    expect(discoveryLayout!.actionsFit).toBe(true)
    expect(discoveryLayout!.actionsStayInRows).toBe(true)
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
    await expect(page.locator('.discover-page')).toBeVisible()
    const desktopBounds = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth
      const page = document.querySelector<HTMLElement>('.discover-page')!
      const controls = page.querySelector<HTMLElement>('.discover-page__controls')!.getBoundingClientRect()
      const tabs = page.querySelector<HTMLElement>('.discover-page__tabs')!.getBoundingClientRect()
      const modes = page.querySelector<HTMLElement>('.discover-page__modes')!.getBoundingClientRect()
      const hero = page.querySelector<HTMLElement>('.discover-next-hero')!
      const copy = hero.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
      const poster = hero.querySelector<HTMLElement>('.discover-spotlight__poster')!.getBoundingClientRect()
      const binge = page.querySelector<HTMLElement>('.discover-binge__feature')
      const contentSections = Array.from(page.querySelectorAll<HTMLElement>(
        '.discover-next-hero, .discover-shelf, .discover-refine, .discover-colors, .discover-genres, .discover-binge, .discover-more',
      )).map((section) => section.getBoundingClientRect())
      return {
        viewport,
        documentWidth: document.documentElement.scrollWidth,
        page: page.getBoundingClientRect().toJSON(),
        headingFontSize: Number.parseFloat(getComputedStyle(page.querySelector<HTMLElement>('.discover-page__heading h1')!).fontSize),
        controlsSameRow: Math.abs((tabs.top + tabs.bottom) / 2 - (modes.top + modes.bottom) / 2) <= 2 && modes.left >= tabs.right - 1,
        controlsInside: controls.left <= tabs.left && controls.right >= modes.right,
        heroHeight: hero.getBoundingClientRect().height,
        sectionsInside: contentSections.every((bounds) => bounds.left >= -1 && bounds.right <= viewport + 1),
        sectionsStacked: contentSections.every((bounds, index) => index === 0 || bounds.height === 0 || contentSections[index - 1]!.height === 0 || contentSections[index - 1]!.bottom <= bounds.top + 1),
        heroColumnsSeparated: copy.right <= poster.left + 1,
        maxPosterCardRatio: Math.max(...Array.from(page.querySelectorAll<HTMLElement>('.discover-page .discover-shelf .media-row-card-slot'), (card) => card.getBoundingClientRect().height / Math.max(1, card.getBoundingClientRect().width))),
        bingeColumns: binge ? getComputedStyle(binge).gridTemplateColumns.split(' ').length : 0,
      }
    })
    expect(desktopBounds.documentWidth, `document overflow at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.page.left, `Discovery shifted offscreen at ${width}px`).toBeGreaterThanOrEqual(-1)
    expect(desktopBounds.page.right, `Discovery exceeds viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.sectionsInside, `a Discovery section exceeds the viewport at ${width}px`).toBe(true)
    expect(desktopBounds.sectionsStacked, `Discovery sections overlap at ${width}px`).toBe(true)
    expect(desktopBounds.controlsSameRow, `Discovery tabs and actions should share one aligned row at ${width}px`).toBe(true)
    expect(desktopBounds.controlsInside, `Discovery tabs and actions should fit the control rail at ${width}px`).toBe(true)
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
    await expect(page.locator('.discover-page')).toBeVisible()
    const desktopBounds = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth
      const page = document.querySelector<HTMLElement>('.discover-page')!
      const controls = page.querySelector<HTMLElement>('.discover-page__controls')!.getBoundingClientRect()
      const tabs = page.querySelector<HTMLElement>('.discover-page__tabs')!.getBoundingClientRect()
      const modes = page.querySelector<HTMLElement>('.discover-page__modes')!.getBoundingClientRect()
      const hero = document.querySelector<HTMLElement>('.discover-next-hero')!
      const contentSections = Array.from(page.querySelectorAll<HTMLElement>(
        '.discover-next-hero, .discover-shelf, .discover-refine, .discover-colors, .discover-genres, .discover-binge, .discover-more',
      )).map((section) => section.getBoundingClientRect())
      const copy = hero.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
      const poster = hero.querySelector<HTMLElement>('.discover-spotlight__poster')!.getBoundingClientRect()
      const shelfCard = page.querySelector<HTMLElement>('.discover-shelf .media-row-card-slot > button')
      return {
        viewport,
        documentWidth: document.documentElement.scrollWidth,
        page: page.getBoundingClientRect().toJSON(),
        headingFontSize: Number.parseFloat(getComputedStyle(page.querySelector<HTMLElement>('.discover-page__heading h1')!).fontSize),
        controlsSameRow: Math.abs((tabs.top + tabs.bottom) / 2 - (modes.top + modes.bottom) / 2) <= 2 && modes.left >= tabs.right - 1,
        controlsInside: controls.left <= tabs.left && controls.right >= modes.right,
        heroHeight: hero.getBoundingClientRect().height,
        heroAnimation: getComputedStyle(hero).animationName,
        shelfCardTransition: shelfCard ? getComputedStyle(shelfCard).transitionProperty : '',
        sectionsInside: contentSections.every((bounds) => bounds.left >= -1 && bounds.right <= viewport + 1),
        sectionsStacked: contentSections.every((bounds, index) => index === 0 || bounds.height === 0 || contentSections[index - 1]!.height === 0 || contentSections[index - 1]!.bottom <= bounds.top + 1),
        heroColumnsSeparated: copy.right <= poster.left + 1,
        maxPosterCardRatio: Math.max(...Array.from(page.querySelectorAll<HTMLElement>('.discover-shelf .media-row-card-slot'), (card) => card.getBoundingClientRect().height / Math.max(1, card.getBoundingClientRect().width))),
      }
    })
    expect(desktopBounds.documentWidth, `Tauri document overflow at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.page.left, `Tauri Discovery shifted offscreen at ${width}px`).toBeGreaterThanOrEqual(-1)
    expect(desktopBounds.page.right, `Tauri Discovery exceeds viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
    expect(desktopBounds.sectionsInside, `a Tauri Discovery section exceeds the viewport at ${width}px`).toBe(true)
    expect(desktopBounds.sectionsStacked, `Tauri Discovery sections overlap at ${width}px`).toBe(true)
    expect(desktopBounds.controlsSameRow, `Tauri Discovery tabs and actions should share one aligned row at ${width}px`).toBe(true)
    expect(desktopBounds.controlsInside, `Tauri Discovery tabs and actions should fit the control rail at ${width}px`).toBe(true)
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
  const spotlightNode = await page.locator('.discover-next-hero').elementHandle()
  const alternateSpotlightItem = page.locator('.discover-next-hero').getByRole('button', { name: /Another option/ })
  if (await alternateSpotlightItem.isEnabled()) {
    const spotlightBeforeAlternate = await page.locator('.discover-next-hero').getAttribute('data-title')
    await alternateSpotlightItem.click()
    await expect.poll(() => page.locator('.discover-next-hero').getAttribute('data-title')).not.toBe(spotlightBeforeAlternate)
  }
  expect(await spotlightNode?.evaluate((element) => element.isConnected), 'changing the editorial pick should animate inside one stable spotlight instead of replacing the whole card').toBe(true)
  await spotlightNode?.dispose()
  const spotlightAfterAlternate = await page.locator('.discover-next-hero').getAttribute('data-title')
  await surpriseButton.click()
  await expect(pickerDialog).toBeVisible()
  await expect(pickerDialog).toHaveAttribute('aria-busy', 'true')
  await expect(pickerDialog.getByRole('status')).toHaveText('Finding something for you')
  await expect(pickerDialog.locator('.discover-picker__poster')).toHaveCSS('animation-name', 'discover-picker-rolling')
  await expect(pickerDialog).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 })
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
  await expect(trendingShelf.locator('.media-row-card-slot').last()).toHaveCSS('animation-delay', '0s')
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
  const continuedGridStagger = await continuedGrid.locator(':scope > button').evaluateAll((cards) => cards.slice(0, 10).map((card) => getComputedStyle(card).animationDelay))
  expect(continuedGridStagger).toEqual(['0s', '0.032s', '0.064s', '0.096s', '0.128s', '0.16s', '0.192s', '0.224s', '0.256s', '0.288s'])
  const continuedBatchStagger = await continuedGrid.locator(':scope > button').evaluateAll((cards) => cards.slice(10, 12).map((card) => getComputedStyle(card).animationDelay))
  expect(continuedBatchStagger).toEqual(['0s', '0.032s'])
  await expect(continuedGrid.getByRole('button').first()).toHaveAccessibleName('More discovery fixture 1 More discovery fixture 1 2026')
  const continuedArtworkTitles = await continuedGrid.locator('img.media-card-artwork').evaluateAll((images) => images.map((image) => image.getAttribute('alt') || ''))
  expect(continuedArtworkTitles.slice(0, 5)).toEqual(Array.from({ length: 5 }, (_, index) => `More discovery fixture ${index + 1}`))
  expect(continuedArtworkTitles).not.toContain(heroTitle)
  expect(continuedArtworkTitles.some((title) => /^Weekly trend \d+$/.test(title))).toBe(false)
  expect(continuationPages).toContain(4)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.mouse.move(0, 0)
  const topTenShelf = page.locator('.discover-shelf').filter({ has: page.getByRole('heading', { name: 'Top 10 For You', exact: true }) })
  const topTenCard = topTenShelf.locator('.media-row--ranked .media-row-card-slot').first()
  await expect.poll(() => topTenCard.locator('[data-hero-viewport]').evaluate((poster) => poster.getBoundingClientRect().width)).toBeLessThan(120)
  const topTenCardMeasure = await topTenCard.evaluate((card) => {
    const button = card.querySelector<HTMLElement>('button')!
    const poster = button.querySelector<HTMLElement>('[data-hero-viewport]')!
    return { posterWidth: poster.getBoundingClientRect().width, rankedHeight: getComputedStyle(button).getPropertyValue('--ranked-card-height').trim() }
  })
  expect(topTenCardMeasure.posterWidth, JSON.stringify(topTenCardMeasure)).toBeGreaterThanOrEqual(100)
  expect(topTenCardMeasure.posterWidth, JSON.stringify(topTenCardMeasure)).toBeLessThanOrEqual(120)
  const tastePickerMobileLayout = await page.locator('.discover-taste-picks').evaluate((grid) => ({
    columns: getComputedStyle(grid).gridTemplateRows.split(' ').length,
    posterWidth: grid.querySelector<HTMLElement>('.discover-taste-pick__poster')?.getBoundingClientRect().width ?? 0,
  }))
  expect(tastePickerMobileLayout.columns, 'mobile taste suggestions should stay in two horizontal rows').toBe(2)
  expect(tastePickerMobileLayout.posterWidth, 'mobile taste posters should follow the roughly three-across reference scale').toBeGreaterThanOrEqual(100)
  expect(tastePickerMobileLayout.posterWidth).toBeLessThanOrEqual(120)
  await topTenShelf.getByRole('button', { name: 'Open Top 10 For You catalog' }).click()
  await expect(page.locator('.catalog-page h1')).toHaveText('Top 10 For You')
  await expect(page.locator('.catalog-page').getByText('10 titles loaded', { exact: true })).toBeVisible()
  await expect(page.locator('.catalog-page__items > button')).toHaveCount(10)
  const catalogGridColumns = await page.locator('.catalog-page__items').evaluate((grid) => new Set(Array.from(grid.children).map((card) => Math.round(card.getBoundingClientRect().left))).size)
  expect(catalogGridColumns).toBe(3)
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  const orTryShelf = page.locator('.discover-shelf--trending')
  await expect.poll(() => orTryShelf.locator('.media-row-card-slot img').evaluateAll((images) => images.some((image) => /^Weekly trend \d+$/.test(image.getAttribute('alt') || ''))), { timeout: 10_000 }).toBe(true)
  const visibleOrTryOrder = await orTryShelf.locator('.media-row-card-slot img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')))
  await orTryShelf.getByRole('button', { name: 'Open OR TRY catalog' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.locator('.catalog-page h1')).toHaveText('OR TRY')
  await expect.poll(() => page.locator('.catalog-page__items > button').count()).toBeGreaterThanOrEqual(visibleOrTryOrder.length)
  const fullOrTryOrder = await page.locator('.catalog-page__items img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')))
  expect(fullOrTryOrder.slice(0, 5), 'the full OR TRY catalog should use the same fresh, popularity-sorted entries as its shelf').toEqual(visibleOrTryOrder.slice(0, 5))
  await page.goBack()
  await expect(page.locator('.discover-page')).toBeVisible()
  await expect(page.locator('.discover-shelf--recent')).toBeVisible()
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
  await expect(retryAnimeContinuation).toBeVisible({ timeout: 20_000 })
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

test('Discovery remains correctly composed across Web and Tauri screen sizes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let markTmdbRequestStarted!: () => void
  const tmdbRequestStarted = new Promise<void>((resolve) => { markTmdbRequestStarted = resolve })
  await page.addInitScript(() => {
    const profileId = 'playwright-discovery-composition-profile'
    localStorage.setItem('aurales_profiles_v1', JSON.stringify([{
      id: profileId,
      name: 'Default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      isDefault: true,
    }]))
    localStorage.setItem('aurales_active_profile_v1', profileId)
    localStorage.setItem(`aurales_skip_profile_picker:profile:${profileId}`, 'true')
    localStorage.setItem(`aurales_local_watchlist_v1:profile:${profileId}`, JSON.stringify([{
      id: 'tmdb-998101', tmdbId: 998101, title: 'Recently Added Composition Fixture', type: 'movie', provider: 'tmdb',
      poster: 'https://image.tmdb.org/t/p/w500/recently-added-composition-fixture.jpg', year: 2026, addedAt: Date.now(),
    }]))
    localStorage.setItem('aurales_app_managed_metadata', 'false')
    localStorage.setItem('tmdb_api_key', 'playwright-public-test-key')
  })
  await page.route('https://api.ids.moe/**', (route) => route.fulfill({ json: {} }))
  await page.route('https://api.themoviedb.org/**', async (route) => {
    markTmdbRequestStarted()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const url = new URL(route.request().url())
    const requestedPage = Number(url.searchParams.get('page') || 1)
    const type = url.pathname.includes('/tv/') || url.pathname.endsWith('/trending/tv/week') ? 'series' : 'movie'
    const results = Array.from({ length: 24 }, (_, index) => ({
      id: 93000 + (requestedPage - 1) * 100 + index,
      title: `Layout fixture ${index + 1}`,
      name: `Layout fixture ${index + 1}`,
      poster_path: `/layout-fixture-${index % 8}.jpg`,
      backdrop_path: '/layout-fixture-backdrop.jpg',
      overview: 'A deterministic popular title for responsive Discovery layout checks.',
      release_date: '2026-10-01',
      first_air_date: '2026-10-01',
      vote_average: 8.2,
      vote_count: 1400,
      popularity: index >= 16 ? 30 - (index - 16) : 240 - index * 5,
      genre_ids: type === 'movie' ? [18, 35, 878, 27, 14] : [18, 10759, 10765],
      original_language: 'en',
    }))
    await route.fulfill({ json: { page: requestedPage, total_pages: 8, total_results: 24 * 8, results } })
  })
  await page.route('https://image.tmdb.org/**', (route) => {
    const isBackdrop = route.request().url().includes('backdrop')
    const artwork = isBackdrop
      ? '<defs><linearGradient id="scene" x2="1" y2="1"><stop stop-color="#115761"/><stop offset=".48" stop-color="#cc653c"/><stop offset="1" stop-color="#171b3b"/></linearGradient></defs><rect width="1200" height="675" fill="url(#scene)"/><circle cx="850" cy="170" r="92" fill="#f4c76d" opacity=".86"/><path d="M0 500 260 260l190 160 220-260 530 390v125H0Z" fill="#111d29" opacity=".72"/><path d="M0 560 290 400l220 120 220-190 470 230v120H0Z" fill="#0c121a" opacity=".7"/>'
      : '<defs><linearGradient id="poster" x2="0" y2="1"><stop stop-color="#df7644"/><stop offset=".52" stop-color="#365e77"/><stop offset="1" stop-color="#111727"/></linearGradient></defs><rect width="400" height="600" fill="url(#poster)"/><circle cx="280" cy="175" r="92" fill="#f5c875" opacity=".78"/><path d="M0 420 110 300l84 80 105-150 101 135v235H0Z" fill="#10202c" opacity=".72"/>'
    return route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${isBackdrop ? '1200 675' : '400 600'}">${artwork}</svg>`,
    })
  })

  await page.goto('/discover')
  const selectProfileButton = page.getByRole('button', { name: /select profile/i })
  if (await selectProfileButton.isVisible().catch(() => false)) await selectProfileButton.click()
  await expect(page.locator('.discover-page')).toBeVisible()
  await tmdbRequestStarted
  await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your Next Obsession' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Your Next Obsession' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pick by Colour' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'How Much Time Tonight?' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sunday Night Moods' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Made for the Big Screen' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Hidden Gems', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'New in Your Library', exact: true })).toBeVisible()

  for (const platform of ['web', 'tauri'] as const) {
    await page.evaluate((runtime) => { document.documentElement.dataset.runtimePlatform = runtime }, platform)
    for (const width of [320, 390, 768, 1024, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 })
      const layout = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('.discover-page')!
        const controls = root.querySelector<HTMLElement>('.discover-page__controls')!.getBoundingClientRect()
        const tabs = root.querySelector<HTMLElement>('.discover-page__tabs')!.getBoundingClientRect()
        const modes = root.querySelector<HTMLElement>('.discover-page__modes')!.getBoundingClientRect()
        const hero = root.querySelector<HTMLElement>('.discover-next-hero')!
        const heroCopy = hero.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
        const heroPoster = hero.querySelector<HTMLElement>('.discover-spotlight__poster')!.getBoundingClientRect()
        const heroTitle = hero.querySelector<HTMLElement>('.discover-spotlight__copy h2')!
        const timeSection = root.querySelector<HTMLElement>('.discover-time')!
        const timeRow = timeSection.querySelector<HTMLElement>('.media-row')
        const timeRowBounds = (timeRow ?? timeSection).getBoundingClientRect()
        const timeCards = Array.from(timeRow?.querySelectorAll<HTMLElement>('.media-row-card-slot') ?? []).map((card) => card.getBoundingClientRect())
        const textBlocks = Array.from(hero.querySelectorAll<HTMLElement>(
          '.discover-spotlight__eyebrow, .discover-spotlight__copy h2, .discover-spotlight__meta, .discover-spotlight__overview, .discover-spotlight__actions',
        )).filter((element) => getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height > 0)
          .map((element) => element.getBoundingClientRect())
        const sections = Array.from(root.querySelectorAll<HTMLElement>(
          '.discover-next-hero, .discover-time, .discover-shelf, .discover-refine, .discover-colors, .discover-genres, .discover-binge, .discover-more',
        )).map((section) => section.getBoundingClientRect())
        const sectionDetails = Array.from(root.querySelectorAll<HTMLElement>(
          '.discover-next-hero, .discover-time, .discover-shelf, .discover-refine, .discover-colors, .discover-genres, .discover-binge, .discover-more',
        )).map((section) => {
          const bounds = section.getBoundingClientRect()
          return { title: section.querySelector('h2')?.textContent?.trim() || section.className, top: bounds.top, bottom: bounds.bottom }
        })
        const editorialHeaders = Array.from(root.querySelectorAll<HTMLElement>('.discover-editorial-heading')).map((header) => {
          const section = header.closest<HTMLElement>('.discover-time, .discover-shelf')!
          const title = header.querySelector<HTMLElement>('h2')!.getBoundingClientRect()
          const tabs = header.querySelector<HTMLElement>('.discover-editorial-tabs')!.getBoundingClientRect()
          return { section: section.getBoundingClientRect(), title: title.toJSON(), tabs: tabs.toJSON(), tabsSeparated: tabs.top >= title.bottom - 1 || tabs.left >= title.right - 1 }
        })
        const editorialButtonHeights = Array.from(root.querySelectorAll<HTMLElement>('.discover-editorial-tabs button')).map((button) => button.getBoundingClientRect().height)
        const posterCards = Array.from(root.querySelectorAll<HTMLElement>('.discover-shelf .media-row-card-slot'))
          .map((card) => card.getBoundingClientRect())
          .filter((bounds) => bounds.width > 0)
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          page: root.getBoundingClientRect().toJSON(),
          controls: controls.toJSON(), tabs: tabs.toJSON(), modes: modes.toJSON(),
          tabLabelsFit: Array.from(root.querySelectorAll<HTMLElement>('.discover-page__tabs button')).every((button) => button.scrollWidth <= button.clientWidth + 4),
          tabLabelWidths: Array.from(root.querySelectorAll<HTMLElement>('.discover-page__tabs button')).map((button) => ({ label: button.textContent?.trim(), width: button.clientWidth, scrollWidth: button.scrollWidth })),
          controlsRowsSeparated: modes.top >= tabs.bottom - 1,
          hero: hero.getBoundingClientRect().toJSON(),
          timeRow: timeRowBounds.toJSON(),
          timeCardsInside: timeCards.every((bounds) => bounds.top >= timeRowBounds.top - 2 && bounds.bottom <= timeRowBounds.bottom + 2),
          headingFontSize: Number.parseFloat(getComputedStyle(root.querySelector<HTMLElement>('.discover-page__heading h1')!).fontSize),
          heroFontFamily: getComputedStyle(heroTitle).fontFamily,
          heroColumnsSeparated: heroCopy.right <= heroPoster.left + 1,
          heroTextContained: textBlocks.every((bounds) => bounds.left >= heroCopy.left - 1 && bounds.right <= heroCopy.right + 1 && bounds.top >= heroCopy.top - 1 && bounds.bottom <= heroCopy.bottom + 1),
          heroTextStacked: textBlocks.every((bounds, index) => index === 0 || textBlocks[index - 1]!.bottom <= bounds.top + 2),
          sectionsInside: sections.every((bounds) => bounds.left >= -1 && bounds.right <= document.documentElement.clientWidth + 1),
          sectionDetails,
          sectionsStacked: sections.every((bounds, index) => index === 0 || bounds.height === 0 || sections[index - 1]!.height === 0 || sections[index - 1]!.bottom <= bounds.top + 1),
          editorialControlsInside: editorialHeaders.every(({ section, tabs }) => tabs.left >= section.left - 1 && tabs.right <= section.right + 1),
          editorialControlsSeparated: editorialHeaders.every(({ tabsSeparated }) => tabsSeparated),
          minEditorialButtonHeight: Math.min(...editorialButtonHeights),
          maxPosterRatio: Math.max(0, ...posterCards.map((bounds) => bounds.height / bounds.width)),
        }
      })
      expect(layout.documentWidth, `${platform} document overflow at ${width}px`).toBeLessThanOrEqual(width + 1)
      expect(layout.page.left, `${platform} Discovery shifted at ${width}px`).toBeGreaterThanOrEqual(-1)
      expect(layout.page.right, `${platform} Discovery exceeds the viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
      expect(layout.sectionsInside, `${platform} Discovery sections exceed ${width}px`).toBe(true)
      expect(layout.sectionsStacked, `${platform} Discovery sections overlap at ${width}px: ${JSON.stringify(layout.sectionDetails)}`).toBe(true)
      expect(layout.editorialControlsInside, `${platform} time/mood controls escape their section at ${width}px`).toBe(true)
      expect(layout.editorialControlsSeparated, `${platform} time/mood headings overlap their controls at ${width}px`).toBe(true)
      expect(layout.minEditorialButtonHeight, `${platform} time/mood touch targets are too small at ${width}px`).toBeGreaterThanOrEqual(44)
      expect(layout.controls.left, `${platform} controls shift at ${width}px`).toBeGreaterThanOrEqual(-1)
      expect(layout.controls.right, `${platform} controls exceed the viewport at ${width}px`).toBeLessThanOrEqual(width + 1)
      if (width <= 370) {
        expect(layout.controlsRowsSeparated, `${platform} narrow-screen actions should move below the readable category tabs at ${width}px`).toBe(true)
        expect(layout.tabLabelsFit, `${platform} category tab labels should not be clipped at ${width}px: ${JSON.stringify(layout.tabLabelWidths)}`).toBe(true)
      } else {
        expect(Math.abs((layout.tabs.top + layout.tabs.bottom) / 2 - (layout.modes.top + layout.modes.bottom) / 2), `${platform} tabs and actions should share a row at ${width}px`).toBeLessThanOrEqual(2)
      }
      expect(layout.heroColumnsSeparated, `${platform} spotlight copy overlaps its poster at ${width}px`).toBe(true)
      expect(layout.timeCardsInside, `${platform} time-fit cards should remain vertically contained at ${width}px`).toBe(true)
      expect(layout.heroTextContained, `${platform} spotlight text escapes its copy column at ${width}px`).toBe(true)
      expect(layout.heroTextStacked, `${platform} spotlight text overlaps at ${width}px`).toBe(true)
      expect(layout.heroFontFamily, `${platform} spotlight should use the app's standard system font`).toContain('system-ui')
      expect(layout.maxPosterRatio, `${platform} posters are stretched at ${width}px`).toBeLessThanOrEqual(2.4)
      expect(layout.headingFontSize, `${platform} Discovery heading is unexpectedly large at ${width}px`).toBeLessThanOrEqual(44)
      if (width >= 900) {
        expect(layout.hero.height, `${platform} spotlight is too short at ${width}px`).toBeGreaterThanOrEqual(300)
        expect(layout.hero.height, `${platform} spotlight is too tall at ${width}px`).toBeLessThanOrEqual(500)
      }
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.runtimePlatform = 'web' })
  await page.setViewportSize({ width: 390, height: 844 })
  const keepExploring = page.locator('.discover-more')
  await keepExploring.scrollIntoViewIfNeeded()
  await expect(keepExploring.locator('xpath=..')).toHaveAttribute('data-revealed', 'true')
  await expect.poll(() => page.locator('.discover-more__grid > *').count(), { timeout: 15_000 }).toBeGreaterThan(0)
  const explorationRowGaps = await page.locator('.discover-more__grid').evaluate((grid) => {
    const cards = Array.from(grid.querySelectorAll<HTMLElement>(':scope > button'))
      .map((card) => card.getBoundingClientRect())
      .filter((bounds) => bounds.width > 0)
      .sort((left, right) => left.top - right.top || left.left - right.left)
    const rows: Array<{ top: number; bottom: number }> = []
    for (const card of cards) {
      const row = rows.find((candidate) => Math.abs(candidate.top - card.top) <= 1)
      if (row) row.bottom = Math.max(row.bottom, card.bottom)
      else rows.push({ top: card.top, bottom: card.bottom })
    }
    const orderedRows = rows.sort((left, right) => left.top - right.top)
    return orderedRows.slice(1).map((row, index) => row.top - orderedRows[index]!.bottom)
  })
  expect(explorationRowGaps.every((gap) => gap <= 18), `Keep Exploring has unnecessary row spacing: ${explorationRowGaps.join(', ')}`).toBe(true)
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
