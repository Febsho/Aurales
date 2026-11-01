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
        genre_ids: [18],
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
  const showAllCard = page.locator('[data-home-shelves] .show-all-card').first()
  await expect(showAllCard).toBeVisible()
  const showAllHeight = await showAllCard.evaluate((element) => element.getBoundingClientRect().height)
  expect(showAllHeight, 'the desktop-sized Show all action must not stretch a mobile catalog row').toBeLessThanOrEqual(190)
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
  expect(measurements!.heroHeight).toBeGreaterThanOrEqual(520)
  expect(measurements!.heroHeight).toBeLessThanOrEqual(580)
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
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    localStorage.setItem('aurales_app_managed_metadata', 'false')
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

  await page.goto('/movie/mobile-layout-fixture')
  await page.getByRole('button', { name: /select profile/i }).click()
  const detail = page.locator('.detail-page--movie')
  await expect(detail).toBeVisible()
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

  await page.getByRole('link', { name: 'Discover' }).click()
  await expect(page.locator('.discover-page')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible()
  const discoveryLayout = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth
    const heading = document.querySelector<HTMLElement>('.discover-page__heading')
    const tabs = document.querySelector<HTMLElement>('.discover-page__tabs')
    const modes = document.querySelector<HTMLElement>('.discover-page__modes')
    const hero = document.querySelector<HTMLElement>('.discover-hero')
    if (!heading || !tabs || !modes) return null
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
      modeButtons: modes ? Array.from(modes.querySelectorAll<HTMLButtonElement>('button'), (button) => {
        const bounds = button.getBoundingClientRect()
        return { left: bounds.left, right: bounds.right, height: bounds.height }
      }) : [],
      hero: hero ? {
        width: hero.getBoundingClientRect().width,
        height: hero.getBoundingClientRect().height,
        left: hero.getBoundingClientRect().left,
        right: hero.getBoundingClientRect().right,
      } : null,
    }
  })
  expect(discoveryLayout).not.toBeNull()
  expect(discoveryLayout!.document).toBeLessThanOrEqual(discoveryLayout!.viewport + 1)
  expect(discoveryLayout!.headingFits).toBe(true)
  expect(discoveryLayout!.tabsFit).toBe(true)
  expect(discoveryLayout!.modesFit).toBe(true)
  expect(discoveryLayout!.modeButtons.length).toBeGreaterThan(1)
  expect(discoveryLayout!.modeButtons.every((button) => button.height >= 44), JSON.stringify(discoveryLayout!.modeButtons)).toBe(true)
  for (let index = 1; index < discoveryLayout!.modeButtons.length; index += 1) {
    expect(discoveryLayout!.modeButtons[index]!.left).toBeGreaterThanOrEqual(discoveryLayout!.modeButtons[index - 1]!.right + 3)
  }
  if (discoveryLayout!.hero) {
    expect(discoveryLayout!.hero.left).toBeGreaterThanOrEqual(0)
    expect(discoveryLayout!.hero.right).toBeLessThanOrEqual(discoveryLayout!.viewport)
    expect(discoveryLayout!.hero.height).toBeLessThanOrEqual(450)
  }

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
