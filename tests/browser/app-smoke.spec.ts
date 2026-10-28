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

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
    }))
    expect(dimensions.page, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1)
    expect(dimensions.height).toBe(viewport.height)

    const settingsLink = navigation.getByRole('link', { name: 'Settings' })
    await settingsLink.focus()
    await expect(settingsLink).toBeFocused()
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

test('mobile cinematic navigation gives every destination a 44px touch target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aurales_navigation_style', 'topbar'))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)

  const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
  await expect(navigation).toBeVisible()
  const targets = await navigation.locator('a').evaluateAll((links) => links.map((link) => {
    const rect = link.getBoundingClientRect()
    return { label: link.getAttribute('aria-label') || link.textContent?.trim(), width: rect.width, height: rect.height }
  }))
  expect(targets.length).toBeGreaterThan(1)
  expect(targets.every((target) => target.width >= 44 && target.height >= 44), JSON.stringify(targets)).toBe(true)
})

test('mobile sidebar destinations meet the same 44px touch target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aurales_navigation_style', 'sidebar'))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)
  const trigger = page.getByRole('button', { name: /open navigation/i })
  // Keep the pointer over the sidebar itself while it expands. This exercises
  // its mouse-enter reveal behavior without moving over a nav link that could
  // cover the collapsed trigger during the transition.
  await page.locator('.app-sidebar').hover({ position: { x: 20, y: 20 } })
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.app-sidebar')).toHaveAttribute('data-expanded', 'true')

  const targets = await page.locator('.app-sidebar__nav a').evaluateAll((links) => links.map((link) => {
    const rect = link.getBoundingClientRect()
    return { label: link.textContent?.trim(), width: rect.width, height: rect.height }
  }))
  expect(targets.length).toBeGreaterThan(1)
  expect(targets.every((target) => target.width >= 44 && target.height >= 44), JSON.stringify(targets)).toBe(true)
})
