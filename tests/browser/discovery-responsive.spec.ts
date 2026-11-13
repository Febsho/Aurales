import { expect, test } from '@playwright/test'

test('mobile Discovery keeps the spotlight and editorial controls inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    const profileId = 'playwright-discovery-responsive'
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
    localStorage.setItem('tmdb_api_key', 'playwright-responsive-test-key')
  })
  await page.route('https://api.ids.moe/**', (route) => route.fulfill({ json: {} }))
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const url = new URL(route.request().url())
    const isSeries = url.pathname.includes('/tv/') || url.pathname.endsWith('/discover/tv')
    const type = isSeries ? 'series' : 'movie'
    const isTrending = /^\/3\/trending\/(movie|tv)\/week$/.test(url.pathname)
    const results = Array.from({ length: isTrending ? 12 : 0 }, (_, index) => ({
      id: (isSeries ? 99000 : 98000) + index,
      title: `${isSeries ? 'Series' : 'Movie'} responsive title ${index + 1}`,
      name: `${isSeries ? 'Series' : 'Movie'} responsive title ${index + 1}`,
      poster_path: `/responsive-${type}-${index + 1}.jpg`,
      backdrop_path: `/responsive-backdrop-${type}-${index + 1}.jpg`,
      release_date: '2026-10-01',
      first_air_date: '2026-10-01',
      vote_average: 8.1,
      vote_count: 1200,
      popularity: 120 - index * 5,
      genre_ids: isSeries ? [18, 10759] : [18, 878],
      original_language: 'en',
    }))
    await route.fulfill({ json: { page: 1, total_pages: 1, total_results: results.length, results } })
  })
  await page.route('https://image.tmdb.org/**', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 3"><rect width="2" height="3" fill="#263244"/></svg>',
  }))

  await page.goto('/discover')
  await expect(page.locator('.discover-page')).toBeVisible()
  await expect(page.locator('.discover-next-hero')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.discover-shelf--trending img').first()).toBeVisible({ timeout: 15_000 })

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    }
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      controls: rect('.discover-page__controls'),
      spotlight: rect('.discover-next-hero'),
      weekendPlan: rect('.discover-weekend-plan'),
      poster: rect('.discover-spotlight__poster-wrap'),
      copy: rect('.discover-spotlight__copy'),
      weekendPoster: rect('.discover-weekend-plan .discover-spotlight__poster-wrap'),
      weekendCopy: rect('.discover-weekend-plan .discover-spotlight__copy'),
    }
  })

  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.controls).not.toBeNull()
  expect(geometry.controls!.left).toBeGreaterThanOrEqual(0)
  expect(geometry.controls!.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.spotlight).not.toBeNull()
  expect(geometry.spotlight!.left).toBeGreaterThanOrEqual(0)
  expect(geometry.spotlight!.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.weekendPlan).not.toBeNull()
  expect(geometry.weekendPlan!.left).toBeGreaterThanOrEqual(0)
  expect(geometry.weekendPlan!.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.poster).not.toBeNull()
  expect(geometry.copy).not.toBeNull()
  expect(geometry.copy!.right).toBeLessThanOrEqual(geometry.poster!.left + 1)
  expect(geometry.weekendPoster).not.toBeNull()
  expect(geometry.weekendCopy).not.toBeNull()
  expect(geometry.weekendCopy!.right).toBeLessThanOrEqual(geometry.weekendPoster!.left + 1)

  for (const width of [320, 360, 430]) {
    await page.setViewportSize({ width, height: 844 })
    const layout = await page.evaluate(() => {
      const copy = document.querySelector<HTMLElement>('.discover-spotlight__copy')!.getBoundingClientRect()
      const poster = document.querySelector<HTMLElement>('.discover-spotlight__poster-wrap')!.getBoundingClientRect()
      const weekendCopy = document.querySelector<HTMLElement>('.discover-weekend-plan .discover-spotlight__copy')!.getBoundingClientRect()
      const weekendPoster = document.querySelector<HTMLElement>('.discover-weekend-plan .discover-spotlight__poster-wrap')!.getBoundingClientRect()
      return {
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        copyRight: copy.right,
        posterLeft: poster.left,
        weekendCopyRight: weekendCopy.right,
        weekendPosterLeft: weekendPoster.left,
      }
    })
    expect(layout.document, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(layout.viewport + 1)
    expect(layout.copyRight, `mobile spotlight columns overlap at ${width}px`).toBeLessThanOrEqual(layout.posterLeft + 1)
    expect(layout.weekendCopyRight, `mobile weekend plan columns overlap at ${width}px`).toBeLessThanOrEqual(layout.weekendPosterLeft + 1)
  }
})
