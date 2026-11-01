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

test('mobile cinematic navigation gives every destination a 44px touch target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aurales_navigation_style', 'topbar'))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)

  const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
  await expect(navigation).toBeVisible()
  await page.waitForFunction(() => {
    const links = document.querySelectorAll<HTMLElement>('nav[aria-label="Primary navigation"] a')
    return links.length > 1 && Array.from(links).every((link) => {
      const rect = link.getBoundingClientRect()
      return rect.width >= 44 && rect.height >= 44
    })
  })
  const targets = await navigation.locator('a').evaluateAll((links) => links.map((link) => {
    const rect = link.getBoundingClientRect()
    return { label: link.getAttribute('aria-label') || link.textContent?.trim(), width: rect.width, height: rect.height }
  }))
  expect(targets.length).toBeGreaterThan(1)
  expect(targets.every((target) => target.width >= 44 && target.height >= 44), JSON.stringify(targets)).toBe(true)
})

test('mobile sidebar destinations meet the same 44px touch target', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aurales_navigation_style', 'sidebar'))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)
  const trigger = page.getByRole('button', { name: /open navigation/i })
  // Use the explicit trigger so this test covers the same interaction that
  // works on touch devices, where hover cannot open the floating sidebar.
  if (testInfo.project.use.isMobile) await trigger.tap()
  else await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.app-sidebar')).toHaveAttribute('data-expanded', 'true')
  await page.waitForFunction(() => {
    const links = document.querySelectorAll<HTMLElement>('.app-sidebar__nav a')
    return links.length > 1 && Array.from(links).every((link) => {
      const rect = link.getBoundingClientRect()
      return rect.width >= 44 && rect.height >= 44
    })
  })

  const targets = await page.locator('.app-sidebar__nav a').evaluateAll((links) => links.map((link) => {
    const rect = link.getBoundingClientRect()
    return { label: link.textContent?.trim(), width: rect.width, height: rect.height }
  }))
  expect(targets.length).toBeGreaterThan(1)
  expect(targets.every((target) => target.width >= 44 && target.height >= 44), JSON.stringify(targets)).toBe(true)
})

test('fixed hero preference uses a swipeable mobile presentation and restores Fixed Focus on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: /Interface/ }).click()
  await page.getByLabel('Home hero layout').click()
  await page.getByRole('option', { name: 'Fixed Focus' }).click()
  await page.getByRole('link', { name: 'Home' }).evaluate((link: HTMLAnchorElement) => link.click())

  const home = page.locator('[data-home-presentation]')
  await expect(home).toHaveAttribute('data-home-presentation', 'dynamic')
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
    document.body.append(fixture)
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
