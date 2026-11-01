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
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: /Interface/ }).click()
  await expect(page.getByLabel('Navigation style')).toHaveCount(0)
  await expect(page.getByLabel('Home hero layout')).toHaveCount(0)
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
  await expect(page.locator('.app-sidebar__nav')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0)
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
  expect(emptyContinueBounds).not.toBeNull()
  expect(emptyContinueBounds!.height, 'an empty Continue Watching shelf should not reserve four landscape cards').toBeLessThanOrEqual(72)
  expect(emptyContinueBounds!.x + emptyContinueBounds!.width).toBeLessThanOrEqual(391)

  // This test environment has no configured catalogue provider, so seed the
  // actual responsive selectors as a DOM fixture instead of silently skipping
  // the measurements when the Home shelves are empty.
  const mobileLayout = await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.innerHTML = `
      <div data-home-presentation="dynamic">
        <div data-home-hero><div style="height: 380px; width: 100%"></div></div>
        <div data-home-shelves>
          <section class="media-row media-row--poster">
            <div class="cinematic-row-track"><div class="media-row-card-slot"><button><div data-hero-viewport></div></button></div></div>
          </section>
        </div>
      </div>`
    document.querySelector('.app-theme-shell')!.append(fixture)
    const hero = fixture.querySelector<HTMLElement>('[data-home-hero] > div')!
    const track = fixture.querySelector<HTMLElement>('.cinematic-row-track')!
    const slot = fixture.querySelector<HTMLElement>('.media-row-card-slot')!
    const result = {
      heroHeight: hero.getBoundingClientRect().height,
      gap: Number.parseFloat(getComputedStyle(track).gap),
      posterWidth: slot.getBoundingClientRect().width,
    }
    fixture.remove()
    return result
  })
  expect(mobileLayout.heroHeight, 'phone Dynamic hero should leave more room for the first shelves').toBeGreaterThan(0)
  expect(mobileLayout.heroHeight).toBeLessThanOrEqual(340)
  expect(mobileLayout.gap).toBeLessThanOrEqual(8)
  expect(mobileLayout.posterWidth).toBeGreaterThan(0)
  expect(mobileLayout.posterWidth).toBeLessThanOrEqual(88)

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
      await route.fulfill({ json: { page: 1, total_pages: 1, total_results: 1, results: [{ id: 43125, title: 'Mobile Fixture Film', poster_path: '/mobile-fixture-poster.jpg', backdrop_path: '/mobile-fixture-backdrop.jpg', overview: 'A fixture for responsive Home layout verification.', release_date: '2025-05-01', vote_average: 8.2, vote_count: 4200, popularity: 220, genre_ids: [18], original_language: 'en' }] } })
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
  expect(skeletonMeasurements.cardWidth).toBeLessThanOrEqual(88)
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
  await expect(rankedCard).toBeVisible()
  const continueEmpty = page.locator('[data-home-shelves] [data-home-row="continue-empty"]')
  const upcomingRow = page.locator('[data-home-shelves] [data-home-row="upcoming"]')
  await expect(continueEmpty.locator('.cw-empty-state')).toBeVisible()
  await expect(upcomingRow.locator('[data-home-upcoming-empty]')).toBeVisible()

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
      gap: Number.parseFloat(getComputedStyle(track).gap),
      posterWidth: poster.getBoundingClientRect().width,
      heroShelfGap: document.querySelector<HTMLElement>('[data-home-shelves]')!.getBoundingClientRect().top - hero.getBoundingClientRect().bottom,
      continueUpcomingGap: upcoming.getBoundingClientRect().top - continueEmpty.getBoundingClientRect().bottom,
      upcomingPosterHeadingGap: posterHeader.getBoundingClientRect().top - upcoming.getBoundingClientRect().bottom,
      upcomingControlHeights: Array.from(upcomingControls, (button) => button.getBoundingClientRect().height),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    } : null
  })
  expect(measurements).not.toBeNull()
  expect(measurements!.heroHeight).toBeGreaterThan(0)
  expect(measurements!.heroHeight).toBeLessThanOrEqual(340)
  expect(measurements!.gap).toBeLessThanOrEqual(8)
  expect(measurements!.posterWidth).toBeGreaterThan(0)
  expect(measurements!.posterWidth).toBeLessThanOrEqual(80)
  const rankedMeasurements = await rankedCard.locator('[data-hero-viewport]').evaluate((art) => ({
    width: art.getBoundingClientRect().width,
    height: art.getBoundingClientRect().height,
  }))
  expect(rankedMeasurements.width, 'mobile ranked artwork should be compact like poster shelves').toBeLessThanOrEqual(96)
  expect(rankedMeasurements.height, 'mobile ranked cards should not retain desktop poster height').toBeLessThanOrEqual(144)
  expect(measurements!.heroShelfGap).toBeLessThanOrEqual(9)
  expect(measurements!.continueUpcomingGap).toBeLessThanOrEqual(21)
  expect(measurements!.upcomingPosterHeadingGap).toBeLessThanOrEqual(21)
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
    return {
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      hero: rect(hero), title: rect(title), overview: rect(overview), actions: rect(actions), nav: rect(nav),
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
  expect(detailLayout!.nav.bottom).toBeLessThanOrEqual(845)

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
  if (discoveryLayout!.hero) {
    expect(discoveryLayout!.hero.left).toBeGreaterThanOrEqual(0)
    expect(discoveryLayout!.hero.right).toBeLessThanOrEqual(discoveryLayout!.viewport)
    expect(discoveryLayout!.hero.height).toBeLessThanOrEqual(390)
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
