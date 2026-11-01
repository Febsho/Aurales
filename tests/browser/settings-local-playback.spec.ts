import { expect, test } from '@playwright/test'

test('browser troubleshooting plays a selected local video through InAppPlayer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()
  await page.getByRole('button', { name: /^Player Hardware decoding, buffering, and playback behavior\.$/i }).click()
  await expect(page.getByRole('heading', { name: 'Player' })).toBeVisible()

  const troubleshooting = page.locator('details').filter({ has: page.getByText('Troubleshooting', { exact: true }) })
  await troubleshooting.locator('summary').click()
  await expect(troubleshooting.getByRole('button', { name: 'Test Local File' })).toBeVisible()
  await expect(troubleshooting.getByRole('button', { name: 'Copy Player Logs' })).toHaveCount(0)

  await troubleshooting.locator('input[type="file"]').setInputFiles({
    name: 'local-playback.mp4',
    mimeType: 'video/mp4',
    buffer: await page.request.get('/tests/browser/fixtures/h264-aac.mp4').then((response) => response.body()),
  })

  const video = page.locator('video').last()
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('src', /^blob:/)
})

test('browser troubleshooting direct HTTP test opens a browser stream', async ({ page }) => {
  const fixture = await page.request.get('/tests/browser/fixtures/h264-aac.mp4').then((response) => response.body())
  await page.route('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', (route) => route.fulfill({
    status: 200,
    contentType: 'video/mp4',
    body: fixture,
  }))
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: /^Player Hardware decoding, buffering, and playback behavior\.$/i }).click()
  const troubleshooting = page.locator('details').filter({ has: page.getByText('Troubleshooting', { exact: true }) })
  await troubleshooting.locator('summary').click()
  await troubleshooting.getByRole('button', { name: 'Test Direct HTTP' }).click()

  const video = page.locator('video').last()
  await expect(video).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Stable HTTP isolation test' })).toBeVisible()
  await expect(video).toHaveAttribute('src', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4')
})

test('browser Accounts settings labels Discord Rich Presence as desktop-only', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aurales_discord_rpc', 'true'))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /select profile/i }).click()
  await expect(page.getByRole('heading', { name: 'Who’s watching?' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()
  await page.getByRole('button', { name: /Accounts Manage connected services/i }).click()

  const discord = page.getByRole('button', { name: 'Discord Rich Presence, Desktop only' })
  await expect(discord).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Enable Discord Rich Presence' })).toHaveCount(0)
  await discord.click()
  await expect(page.getByText(/only available in Aurales desktop/i)).toBeVisible()
})
